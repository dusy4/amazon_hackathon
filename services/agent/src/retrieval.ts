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
import { Bm25, cosine } from "../../media/src/text.ts";

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

export class MomentRetriever {
  private bm25 = new Map<string, Bm25>();
  private embedders = new Map<string, Embedder>();
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

  async search(index: ContentIndex, q: MomentQuery, playheadMs: number): Promise<MomentSearchResult> {
    const anchor = q.anchorMs ?? playheadMs;
    const relation = q.relation ?? "any";
    const lexAll = this.bm25For(index).score(q.query || "");
    const lexMax = Math.max(1e-9, ...lexAll);
    const [qv] = q.query ? await this.embedderForIndex(index).embed([q.query], "query") : [[]];
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
    if (!hasStructure) scored = scored.filter((x) => x.breakdown.lexical > 0 || x.breakdown.semantic >= 0.35);

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
    }));
    return {
      moments,
      hiddenBySpoilerBoundary: hidden,
      bestMatchHidden,
      reranker: rerankedBy,
      embeddingModel: index.embeddingModel,
      constraints: { relation, anchorMs: anchor, eventTypes: q.eventTypes, entityIds: q.entityIds, replayOfEventId: q.replayOfEventId, ordinal: q.ordinal, spoilerBoundaryMs: boundary },
    };
  }
}
