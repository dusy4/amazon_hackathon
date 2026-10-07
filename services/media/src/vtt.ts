/**
 * WebVTT → transcript lines.
 *
 * Handles both manual subtitles (one cue = one line) and YouTube auto-captions, whose cues repeat the
 * previous line ("rolling" captions) and carry per-word timings as <00:00:01.260><c> word</c>. For
 * auto-captions only the newly spoken words of each cue are kept, with their own timestamps, and words are
 * regrouped into lines of at most ~8 s (or at sentence ends).
 */
import type { TranscriptLine } from "../../../packages/contracts/src/index.ts";

const ts = (s: string) => {
  const [h, m, rest] = s.length > 9 ? s.split(":") : ["0", ...s.split(":")];
  return Math.round((Number(h) * 3600 + Number(m) * 60 + Number(rest)) * 1000);
};

const clean = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/\s+/g, " ")
    .trim();

export function parseVtt(vtt: string, speaker = "speaker"): TranscriptLine[] {
  const cues: { start: number; end: number; lines: string[] }[] = [];
  const blocks = vtt.replace(/\r/g, "").split(/\n\n+/);
  for (const b of blocks) {
    const rows = b.split("\n");
    const i = rows.findIndex((r) => r.includes("-->"));
    if (i < 0) continue;
    const [a, z] = rows[i].split("-->").map((x) => x.trim().split(" ")[0]);
    cues.push({ start: ts(a), end: ts(z), lines: rows.slice(i + 1) });
  }
  const rolling = cues.some((c) => c.lines.some((l) => /<\d\d:\d\d:\d\d\.\d+><c>/.test(l)));
  const words: { ms: number; w: string }[] = [];
  const lines: TranscriptLine[] = [];
  if (!rolling) {
    for (const c of cues) {
      const text = clean(c.lines.join(" "));
      if (text) lines.push({ id: `tx-${lines.length + 1}`, startMs: c.start, endMs: c.end, speaker, text });
    }
    return lines;
  }
  for (const c of cues) {
    const fresh = c.lines.find((l) => /<\d\d:\d\d:\d\d\.\d+><c>/.test(l));
    if (!fresh) continue;
    // "first<00:00:01.260><c> word</c>…": the leading word starts at the cue start.
    const parts = fresh.split(/(<\d\d:\d\d:\d\d\.\d+>)/);
    let at = c.start;
    for (const p of parts) {
      const m = p.match(/^<(\d\d:\d\d:\d\d\.\d+)>$/);
      if (m) at = ts(m[1]);
      else for (const w of clean(p).split(" ").filter(Boolean)) words.push({ ms: at, w });
    }
  }
  let cur: TranscriptLine | null = null;
  for (let i = 0; i < words.length; i++) {
    const { ms, w } = words[i];
    const next = words[i + 1]?.ms ?? ms + 600;
    if (!cur || ms - cur.startMs > 8000 || ms - cur.endMs > 1500) {
      cur = { id: `tx-${lines.length + 1}`, startMs: ms, endMs: next, speaker, text: w };
      lines.push(cur);
    } else {
      cur.text += ` ${w}`;
      cur.endMs = Math.max(cur.endMs, next);
    }
    if (/[.!?]$/.test(w)) cur = null;
  }
  return lines;
}
