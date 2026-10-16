/**
 * Entity canonicalisation for real footage.
 *
 * Captions (speech recognition) mishear names — "Robbie King", "Bobby Keen" for Robbie Keane — and the
 * segment-description model copies them. Names that Amazon Rekognition RecognizeCelebrities actually
 * recognised in the frames are trusted; a caption-only name that is a near-miss of a trusted one is merged
 * into it. The misheard spelling is kept as an alias so it still resolves.
 */
import type { ContentIndex } from "../../../packages/contracts/src/index.ts";

/** Normalised Levenshtein similarity in [0, 1]. */
export function similarity(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
}

/** Consonant skeleton: first letter + following consonants, doubled letters collapsed ("Keane" → "kn", "King" → "kng"). */
const skeleton = (w: string) => {
  const s = w.toLowerCase().replace(/[^a-z]/g, "");
  return (s[0] ?? "") + s.slice(1).replace(/[aeiouy]/g, "").replace(/(.)\1+/g, "$1");
};
/** Spelling or sound-alike similarity, whichever is higher. */
export const nameSimilarity = (a: string, b: string) => Math.max(similarity(a, b), similarity(skeleton(a), skeleton(b)));

const isTrusted = (e: { description?: string }) => /amazon-rekognition/i.test(e.description ?? "");
const surname = (n: string) => n.trim().split(/\s+/).pop() ?? n;

/** Map of caption-only person id → trusted person id. */
export function findMerges(index: Pick<ContentIndex, "entities">) {
  const people = index.entities.filter((e) => e.type === "person");
  const trusted = people.filter(isTrusted);
  const merges = new Map<string, string>();
  for (const e of people) {
    if (isTrusted(e) || e.name.trim().split(/\s+/).length < 2) continue;
    let best: { id: string; score: number } | null = null;
    const [first] = e.name.trim().split(/\s+/);
    for (const t of trusted) {
      const [tFirst] = t.name.trim().split(/\s+/);
      const ls = surname(e.name), lt = surname(t.name);
      if (ls[0]?.toLowerCase() !== lt[0]?.toLowerCase()) continue; // surnames must start alike
      const score = (nameSimilarity(first, tFirst) + nameSimilarity(ls, lt)) / 2;
      const fs = nameSimilarity(first, tFirst);
      const sn = nameSimilarity(ls, lt);
      // Both names near-misses, or a near-identical surname with a sound-alike first name ("Bobby Keen").
      const match = (fs >= 0.6 && sn >= 0.6) || (sn >= 0.9 && fs >= 0.5);
      if (match && (!best || score > best.score)) best = { id: t.id, score };
    }
    if (best) merges.set(e.id, best.id);
  }
  return merges;
}

export function canonicalize(index: ContentIndex) {
  const merges = findMerges(index);
  if (!merges.size) return { index, merges };
  const byId = new Map(index.entities.map((e) => [e.id, e]));
  const renames: [RegExp, string][] = [];
  for (const [from, to] of merges) {
    const src = byId.get(from)!;
    const dst = byId.get(to)!;
    dst.aliases = [...new Set([...(dst.aliases ?? []), src.name, ...(src.aliases ?? []).filter((a) => a !== surname(src.name))])];
    renames.push([new RegExp(`\\b${src.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), dst.name]);
  }
  const fixText = (s?: string) => (s ? renames.reduce((acc, [re, to]) => acc.replace(re, to), s) : s);
  const fixIds = (ids?: string[]) => (ids ? [...new Set(ids.map((id) => merges.get(id) ?? id))] : ids);
  for (const ev of index.events as any[]) {
    ev.title = fixText(ev.title);
    ev.description = fixText(ev.description);
    ev.entityIds = fixIds(ev.entityIds);
  }
  for (const s of index.segments) {
    s.label = fixText(s.label)!;
    s.text = fixText(s.text)!;
    s.entityIds = fixIds(s.entityIds)!;
  }
  for (const p of ((index as any).presence ?? []) as { entityId: string; name: string }[]) {
    if (merges.has(p.entityId)) {
      p.entityId = merges.get(p.entityId)!;
      p.name = byId.get(p.entityId)!.name;
    }
  }
  index.entities = index.entities.filter((e) => !merges.has(e.id));
  return { index, merges };
}
