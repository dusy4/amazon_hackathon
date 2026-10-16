/**
 * Hybrid moment retrieval (v3).
 *
 *   1. Structural filters: event type, replay-of, entity, before/after — deterministic.
 *   2. Three ranked channels: dense embeddings (semantic), BM25 (exact names, numbers, sign text),
 *      entity overlap. Fused with Reciprocal Rank Fusion (Cormack et al., SIGIR 2009; k = 60), which
 *      works on ranks and so avoids mixing cosine and BM25 score scales.
 *   3. Optional cross-encoder rerank of the fused top-N (Cohere Rerank 3.5 on Bedrock).
 *   4. Spoiler boundary and temporal ordering.
 *
 * Temporal relations ("the last goal", "the save before the second goal", "the second goal")
 * are deterministic filters and orderings — the embedding model is never asked to do relative time.
 */
import type { ContentIndex, Moment, Segment } from "../../../packages/contracts/src/index.ts";
import { type Embedder, embedderFor } from "../../media/src/embeddings.ts";
import { type Reranker, defaultReranker } from "../../media/src/rerank.ts";
import { Bm25, cosine, tokenize } from "../../media/src/text.ts";

export interface MomentQuery {
  query: string;
  eventTypes?: string[];
  /** Hard filter: segment must involve at least one of these entities. */
  entityIds?: string[];
  /** Only replay segments of this event. */
  replayOfEventId?: string;
  relation?: "before" | "after" | "any";
  /** Anchor for before/after; defaults to the playhead. */
  anchorMs?: number;
  order?: "relevance" | "nearest" | "chronological" | "first" | "last";
  /** 1-based ordinal over the chronological, constraint-filtered results ("the second goal"). */
  ordinal?: number;
  /** Strict spoiler mode: nothing that starts after this point is returned. */
  spoilerBoundaryMs?: number;
  includeWindows?: boolean;
  limit?: number;
}

export interface MomentSearchResult {
  moments: Moment[];
  /** Number of matches hidden by the spoiler boundary. */
  hiddenBySpoilerBoundary: number;
  /** Relevance-ordered queries: the single best match overall lies past the spoiler boundary. */
  bestMatchHidden: boolean;
  reranker: string | null;
  /** Set when a retrieval channel failed and results come from the remaining channels. */
  degraded?: string;
  embeddingModel: string;
  constraints: Record<string, unknown>;
}

const RRF_K = 60;
const CHANNEL_WEIGHT = { semantic: 1, lexical: 1, entity: 0.5 };
const RERANK_TOP_N = 20;

/** Reference time of a segment for temporal comparisons: the event itself, not its lead-in. */
function eventTime(index: ContentIndex, s: Segment) {
  const ev = s.eventId ? index.events.find((e) => e.id === s.eventId) : undefined;
  return ev ? ev.startMs : s.startMs;
}

/** The transcript line inside a segment that shares the most terms with the query (empty if none). */
function bestLine(index: ContentIndex, s: Segment, query: string): string | undefined {
  const qt = new Set(tokenize(query));
  if (!qt.size) return undefined;
  let best: { text: string; n: number } | undefined;
  for (const l of index.transcript) {
    if (l.endMs < s.startMs || l.startMs > s.endMs) continue;
    const n = tokenize(l.text).filter((t) => qt.has(t)).length;
    if (n && (!best || n > best.n)) best = { text: l.text, n };
  }
  return best?.text.slice(0, 200);
}

export class MomentRetriever {
  private bm25 = new Map<string, Bm25>();
  private embedders = new Map<string, Embedder>();
  private queryCache = new Map<string, number[]>();
  constructor(private reranker: Reranker | null = defaultReranker()) {}

  private bm25For(index: ContentIndex) {
    let b = this.bm25.get(index.contentId);
    if (!b) this.bm25.set(index.contentId, (b = new Bm25(index.segments.map((s) => s.text))));
    return b;
  }

  private embedderForIndex(index: ContentIndex) {
    let e = this.embedders.get(index.embeddingModel);
    if (!e) this.embedders.set(index.embeddingModel, (e = embedderFor(index.embeddingModel, index.embeddingDim)));
    return e;
  }

  /**
   * Hard filters (event type, entity) come from the agent's reading of the request and can be wrong for a
   * given title. If a filter leaves nothing to rank, relax it (event types first, then entities) and say so,
   * instead of returning an empty result the agent would keep retrying.
   */
  async search(index: ContentIndex, q: MomentQuery, playheadMs: number): Promise<MomentSearchResult> {
    const first = await this.searchOnce(index, q, playheadMs);
    if (first.moments.length || first.hiddenBySpoilerBoundary || q.replayOfEventId) return first;
    const relaxed: string[] = [];
    let cur = q;
    for (const key of ["eventTypes", "entityIds"] as const) {
      if (!cur[key]?.length) continue;
      cur = { ...cur, [key]: undefined };
      relaxed.push(key);
      const r = await this.searchOnce(index, cur, playheadMs);
      if (r.moments.length || r.hiddenBySpoilerBoundary) return { ...r, constraints: { ...r.constraints, relaxed, requested: { eventTypes: q.eventTypes, entityIds: q.entityIds } } };
    }
    return first;
  }

  private async searchOnce(index: ContentIndex, q: MomentQuery, playheadMs: number): Promise<MomentSearchResult> {
    const anchor = q.anchorMs ?? playheadMs;
    const relation = q.relation ?? "any";
    const lexAll = this.bm25For(index).score(q.query || "");
    const lexMax = Math.max(1e-9, ...lexAll);
    // Semantic channel: a failing embedding call (quota, network) degrades to lexical + entity, visibly.
    let qv: number[] = [];
    let degraded: string | undefined;
    if (q.query) {
      const key = `${index.embeddingModel}|${q.query}`;
      const hit = this.queryCache.get(key);
      if (hit) qv = hit;
      else
        try {
          // A TV request can't wait on a slow embedding API (a free-tier call once took 30 s): after the budget,
          // rank without the semantic channel. The late vector still lands in the cache for the next ask.
          const budget = Number(process.env.SP_EMBED_BUDGET_MS ?? 2500);
          const call = this.embedderForIndex(index).embed([q.query], "query").then(([v]) => {
            this.queryCache.set(key, v);
            if (this.queryCache.size > 500) this.queryCache.delete(this.queryCache.keys().next().value!);
            return v;
          });
          call.catch(() => {});
          const v = await Promise.race([call, new Promise<null>((r) => setTimeout(() => r(null), budget).unref?.())]);
          if (!v) throw new Error(`embedding took longer than ${budget} ms`);
          qv = v;
        } catch (e) {
          degraded = `semantic channel unavailable (${(e as Error).message.slice(0, 80)}); ranked by keywords + entities`;
        }
    }
    const hasStructure = !!(q.eventTypes?.length || q.replayOfEventId || q.entityIds?.length);

    const candidates = index.segments
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => {
        if (s.kind === "window" && (hasStructure || q.includeWindows === false) && !q.includeWindows) return false;
        if (q.replayOfEventId) return s.kind === "replay" && s.ofEventId === q.replayOfEventId;
        if (q.eventTypes?.length && !q.eventTypes.includes(s.eventType ?? "")) return false;
        if (q.entityIds?.length && !s.entityIds.some((id) => q.entityIds!.includes(id))) return false;
        const t = eventTime(index, s);
        if (relation === "before" && !(t <= anchor)) return false;
        if (relation === "after" && !(t > anchor + 500)) return false;
        return true;
      })
      .map(({ s, i }) => ({
        s,
        semantic: qv.length && s.embedding ? Math.max(0, cosine(qv, s.embedding)) : 0,
        lexical: lexAll[i] / lexMax,
        entity: q.entityIds?.length ? s.entityIds.filter((id) => q.entityIds!.includes(id)).length / q.entityIds.length : 0,
      }));

    // Reciprocal Rank Fusion over the channels that carry signal for this query.
    const rrf = new Map<(typeof candidates)[number], number>();
    const fuse = (channel: keyof typeof CHANNEL_WEIGHT, active: boolean) => {
      if (!active) return;
      const ranked = candidates.filter((c) => c[channel] > 0).sort((a, b) => b[channel] - a[channel]);
      ranked.forEach((c, r) => rrf.set(c, (rrf.get(c) ?? 0) + CHANNEL_WEIGHT[channel] / (RRF_K + r + 1)));
    };
    fuse("semantic", qv.length > 0);
    fuse("lexical", !!q.query);
    fuse("entity", !!q.entityIds?.length);

    let scored = candidates.map((c) => ({
      s: c.s,
      score: rrf.get(c) ?? 0,
      breakdown: { semantic: +c.semantic.toFixed(3), lexical: +c.lexical.toFixed(3), entity: +c.entity.toFixed(3), rrf: +(rrf.get(c) ?? 0).toFixed(4) } as Record<string, number>,
    }));

    // Free-text queries without structure need some evidence: a lexical hit or real semantic similarity.
    // Cosine scales differ per embedding model, so the semantic bar is relative to the best candidate.
    if (!hasStructure) {
      const top = Math.max(0, ...scored.map((x) => x.breakdown.semantic));
      scored = scored.filter((x) => x.breakdown.lexical > 0 || (top > 0 && x.breakdown.semantic >= 0.6 * top));
    }

    let rerankedBy: string | null = null;
    const wantsRelevance = (q.order ?? (q.ordinal ? "chronological" : relation === "before" ? "nearest" : "relevance")) === "relevance";
    if (this.reranker && q.query && wantsRelevance && scored.length > 1) {
      const top = [...scored].sort((a, b) => b.score - a.score).slice(0, RERANK_TOP_N);
      try {
        const rs = await this.reranker.score(q.query, top.map((x) => `${x.s.label}. ${x.s.text}`));
        top.forEach((x, i) => {
          x.breakdown.rerank = +rs[i].toFixed(3);
          x.score = 1 + rs[i]; // reranked items always outrank the unreranked tail
        });
        rerankedBy = this.reranker.model;
      } catch (e) {
        rerankedBy = `failed: ${(e as Error).message.slice(0, 80)}`;
      }
    }

    const boundary = q.spoilerBoundaryMs;
    const isVisible = (x: (typeof scored)[number]) => boundary == null || eventTime(index, x.s) <= boundary + 1000;
    const visible = scored.filter(isVisible);
    const hidden = scored.length - visible.length;
    const best = [...scored].sort((a, b) => b.score - a.score)[0];
    const bestMatchHidden = wantsRelevance && !!best && !isVisible(best);

    const chrono = [...visible].sort((a, b) => a.s.startMs - b.s.startMs);
    let ordered: typeof visible;
    switch (q.order ?? (q.ordinal ? "chronological" : relation === "before" ? "nearest" : "relevance")) {
      case "nearest":
        ordered = [...visible].sort((a, b) => Math.abs(anchor - eventTime(index, a.s)) - Math.abs(anchor - eventTime(index, b.s)));
        break;
      case "chronological":
      case "first":
        ordered = chrono;
        break;
      case "last":
        ordered = chrono.reverse();
        break;
      default:
        ordered = [...visible].sort((a, b) => b.score - a.score);
    }
    if (q.ordinal) ordered = ordered.slice(q.ordinal - 1, q.ordinal);

    const moments: Moment[] = ordered.slice(0, q.limit ?? 10).map(({ s, score, breakdown }) => ({
      segmentId: s.id,
      kind: s.kind,
      eventId: s.eventId,
      eventType: s.eventType,
      ofEventId: s.ofEventId,
      startMs: s.startMs,
      endMs: s.endMs,
      label: s.label,
      score: +score.toFixed(4),
      scoreBreakdown: breakdown,
      entityIds: s.entityIds,
      // Evidence lets the agent verify a match instead of trusting a label: what the moment is and the
      // spoken line that best matches the request.
      description: index.events.find((e) => e.id === s.eventId)?.description?.slice(0, 240),
      evidence: bestLine(index, s, q.query),
    }));
    return {
      moments,
      hiddenBySpoilerBoundary: hidden,
      bestMatchHidden,
      reranker: rerankedBy,
      embeddingModel: index.embeddingModel,
      ...(degraded ? { degraded } : {}),
      constraints: { relation, anchorMs: anchor, eventTypes: q.eventTypes, entityIds: q.entityIds, replayOfEventId: q.replayOfEventId, ordinal: q.ordinal, spoilerBoundaryMs: boundary },
    };
  }
}
