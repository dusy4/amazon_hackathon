/**
 * Entity resolution: "Silva", "#7", "number seven", "Northgate's number 9", "the keeper" →
 * canonical entity IDs, disambiguated by what is happening around the playhead.
 */
import type { ContentIndex, Entity } from "../../../packages/contracts/src/index.ts";

export const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};

function teamIn(index: ContentIndex, text: string): string | undefined {
  const t = text.toLowerCase();
  for (const team of index.teams) {
    const first = team.name.split(" ")[0].toLowerCase();
    if (t.includes(team.name.toLowerCase()) || new RegExp(`\\b${first}\\b`).test(t) || new RegExp(`\\b${team.short.toLowerCase()}\\b`).test(t))
      return team.id;
  }
  return undefined;
}

/** Most recent involvement of an entity at or before `atMs` (touches + events) — used for disambiguation. */
function lastInvolvement(index: ContentIndex, e: Entity, atMs: number) {
  let best = -Infinity;
  for (const t of index.touches) if (t.team === e.team && t.number === e.number && t.ms <= atMs) best = Math.max(best, t.ms);
  for (const ev of index.events)
    if (ev.startMs <= atMs && ev.players.some((p) => p.team === e.team && p.number === e.number)) best = Math.max(best, ev.startMs);
  return best;
}

export interface Resolution {
  entity: Entity;
  matchedBy: string;
  confidence: number;
}

export function resolveEntities(index: ContentIndex, text: string, atMs: number): Resolution[] {
  const t = text.toLowerCase();
  const players = index.entities.filter((e) => e.type === "player");
  const team = teamIn(index, t);
  const out: Resolution[] = [];

  for (const p of players) if (new RegExp(`\\b${p.name.toLowerCase()}\\b`).test(t)) out.push({ entity: p, matchedBy: "name", confidence: 1 });

  const numRe = /(?:#|\bnumber\s+|\bno\.?\s*)(\d{1,2}|[a-z]+)\b/g;
  for (const m of t.matchAll(numRe)) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUMBER_WORDS[m[1]];
    if (!n) continue;
    let cands = players.filter((p) => p.number === n && (!team || p.team === team));
    if (cands.length > 1) {
      cands = cands.sort((a, b) => lastInvolvement(index, b, atMs) - lastInvolvement(index, a, atMs)).slice(0, 1);
      out.push({ entity: cands[0], matchedBy: `#${n} (most recently involved team)`, confidence: 0.75 });
    } else if (cands[0]) out.push({ entity: cands[0], matchedBy: `#${n}${team ? ` ${team}` : ""}`, confidence: 1 });
  }

  if (/\b(goal ?keeper|keeper|goalie)\b/.test(t)) {
    let gks = players.filter((p) => p.role === "GK" && (!team || p.team === team));
    if (gks.length > 1) gks = gks.sort((a, b) => lastInvolvement(index, b, atMs) - lastInvolvement(index, a, atMs));
    if (gks[0]) out.push({ entity: gks[0], matchedBy: "role:goalkeeper", confidence: team ? 1 : 0.7 });
  }

  if (!out.length && team && !/\b(goal|replay|card|save|shot)\b/.test(t)) {
    const te = index.entities.find((e) => e.id === `team:${team}`);
    if (te) out.push({ entity: te, matchedBy: "team name", confidence: 1 });
  }
  const seen = new Set<string>();
  return out.filter((r) => !seen.has(r.entity.id) && seen.add(r.entity.id));
}

export { teamIn };
