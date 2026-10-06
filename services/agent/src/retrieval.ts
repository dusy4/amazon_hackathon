/**
 * Hybrid moment retrieval (v2 "Semantic retrieval architecture").
 *
 *   finalScore = semantic + lexical + entityMatch + eventMatch, then temporal constraints/ordering.
 *
 * Temporal relations ("the last goal", "the save before the second goal", "the second goal")
 * are deterministic filters and orderings — the embedding model is never asked to do relative time.
 */
import type { ContentIndex, Moment, Segment } from "../../../packages/contracts/src/index.ts";
import { type Embedder, embedderFor } from "../../media/src/embeddings.ts";
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
  embeddingModel: string;
  constraints: Record<string, unknown>;
}

const W = { semantic: 0.35, lexical: 0.35, entity: 0.15, event: 0.15 };

/** Reference time of a segment for temporal comparisons: the event itself, not its lead-in. */
function eventTime(index: ContentIndex, s: Segment) {
  const ev = s.eventId ? index.events.find((e) => e.id === s.eventId) : undefined;
  return ev ? ev.startMs : s.startMs;
}

export class MomentRetriever {
  private bm25 = new Map<string, Bm25>();
  private embedders = new Map<string, Embedder>();

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

    let scored = index.segments
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
      .map(({ s, i }) => {
        const semantic = qv.length && s.embedding ? Math.max(0, cosine(qv, s.embedding)) : 0;
        const lexical = lexAll[i] / lexMax;
        const entity = q.entityIds?.length ? s.entityIds.filter((id) => q.entityIds!.includes(id)).length / q.entityIds.length : 0;
        const event = q.eventTypes?.length || q.replayOfEventId ? 1 : 0;
        const score = W.semantic * semantic + W.lexical * lexical + W.entity * entity + W.event * event;
        return { s, score, breakdown: { semantic: +semantic.toFixed(3), lexical: +lexical.toFixed(3), entity: +entity.toFixed(3), event } };
      });

    // Free-text queries without structure need a minimum relevance.
    if (!hasStructure) scored = scored.filter((x) => x.score > 0.12);

    const boundary = q.spoilerBoundaryMs;
    const visible = boundary == null ? scored : scored.filter((x) => eventTime(index, x.s) <= boundary + 1000);
    const hidden = scored.length - visible.length;

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
      score: +score.toFixed(3),
      scoreBreakdown: breakdown,
      entityIds: s.entityIds,
    }));
    return {
      moments,
      hiddenBySpoilerBoundary: hidden,
      embeddingModel: index.embeddingModel,
      constraints: { relation, anchorMs: anchor, eventTypes: q.eventTypes, entityIds: q.entityIds, replayOfEventId: q.replayOfEventId, ordinal: q.ordinal, spoilerBoundaryMs: boundary },
    };
  }
}
