/**
 * Commentary lag correction for real footage.
 *
 * Segment types come from captions, and commentators name a goal after it has gone in ("…and Bolt scores!"),
 * so a "goal" segment starts on the celebration. Watching a goal means watching the build-up and the strike:
 * goal-like moments start earlier by a fixed lead-in. The captioned start is kept as `captionedStartMs`.
 * Idempotent: the index records that the correction was applied.
 */
import type { ContentIndex } from "../../../packages/contracts/src/index.ts";

export const LEAD_IN_MS: Record<string, number> = { goal: 10_000, chance: 5_000, shot: 5_000, save: 5_000 };

export function applyLeadIn(index: ContentIndex): number {
  const sources = index.sources as Record<string, string>;
  if (index.kind !== "video" || sources.leadIn) return 0;
  let n = 0;
  for (const e of index.events as any[]) {
    const lead = LEAD_IN_MS[e.type];
    if (!lead) continue;
    const from = Math.max(0, e.startMs - lead);
    for (const s of index.segments.filter((s) => s.eventId === e.id) as any[]) {
      s.captionedStartMs = s.startMs;
      s.startMs = from;
    }
    e.captionedStartMs = e.startMs;
    e.startMs = from;
    n++;
  }
  sources.leadIn = `goal −${LEAD_IN_MS.goal / 1000} s, chance/shot/save −${LEAD_IN_MS.chance / 1000} s (commentary lag)`;
  return n;
}
