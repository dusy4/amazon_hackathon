/**
 * Ingest real footage (v2 pre-indexing flow, implemented with what this account can call today):
 *
 *   video.mp4 → S3 → Amazon Rekognition Video segment detection (shots)
 *             → shots merged into 6–20 s retrieval segments (each segment = one retrievable moment)
 *             → keyframe per segment → Rekognition DetectLabels + DetectText + RecognizeCelebrities
 *   captions  → transcript (YouTube captions now; Amazon Transcribe once the account is verified)
 *   LLM       → per-segment title / description / event type / people, grounded only in the transcript and
 *               the Rekognition observations (Pegasus or Nova video understanding is the target here)
 *   embeddings→ per-segment vectors (OpenRouter now; Nova Multimodal Embeddings is the target)
 *
 * Every expensive step is cached in data/content/<id>/analysis/*.json, so re-running is free.
 * Usage: npm run ingest:video -- <contentId>
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentIndex, Entity, ProviderEvent, Segment, TranscriptLine } from "../../../packages/contracts/src/index.ts";
import { formatMs } from "../../../packages/contracts/src/index.ts";
import { defaultChatModel } from "../../agent/src/llm.ts";
import { type Embedder, defaultEmbedder } from "./embeddings.ts";
import { type FrameAnalysis, type Shot, analyzeFrame, detectShots, uploadOnce } from "./rekognition.ts";
import { parseVtt } from "./vtt.ts";

const BUCKET = process.env.SP_MEDIA_BUCKET ?? "semantic-playback-496494569308";
const MIN_SEG = 6000;
const MAX_SEG = 20000;

interface Described {
  i: number;
  title: string;
  description: string;
  type: string;
  people: string[];
}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function cached<T>(dir: string, name: string, fn: () => Promise<T>, log: (s: string) => void): Promise<T> {
  const p = join(dir, "analysis", `${name}.json`);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  log(`${name}: computing…`);
  const v = await fn();
  mkdirSync(join(dir, "analysis"), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 1));
  return v;
}

/** Merge shots into retrieval segments: cut only at shot boundaries, 6–20 s, splitting very long shots. */
export function shotsToSegments(shots: Shot[], durationMs: number) {
  const cuts = [...new Set([0, ...shots.map((s) => s.startMs), durationMs])].filter((t) => t >= 0 && t <= durationMs).sort((a, b) => a - b);
  const segs: { startMs: number; endMs: number }[] = [];
  let start = 0;
  for (let k = 1; k < cuts.length; k++) {
    const t = cuts[k];
    if (t - start < MIN_SEG && t !== durationMs) continue;
    for (let s = start; s < t; s += MAX_SEG) segs.push({ startMs: s, endMs: Math.min(t, s + MAX_SEG) });
    start = t;
  }
  // A short tail joins the previous segment.
  const last = segs[segs.length - 1];
  if (segs.length > 1 && last.endMs - last.startMs < MIN_SEG / 2) {
    segs.pop();
    segs[segs.length - 1].endMs = last.endMs;
  }
  return segs;
}

export function keyframe(video: string, atMs: number): Uint8Array {
  return execFileSync("ffmpeg", ["-loglevel", "error", "-ss", (atMs / 1000).toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=960:-1", "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "-"], { maxBuffer: 16 << 20 });
}

function extractJson(text: string): any {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in model output: ${text.slice(0, 120)}`);
  return JSON.parse(m[0]);
}

async function describeSegments(
  meta: { title: string; channel: string; description: string },
  segs: { startMs: number; endMs: number; transcript: string; frame: FrameAnalysis }[],
  log: (s: string) => void,
): Promise<{ model: string; items: Described[] }> {
  const model = defaultChatModel();
  if (!model) throw new Error("SP_LLM must be set to describe segments");
  const system =
    "You index a video for semantic search and playback navigation. For each numbered segment write what happens in it, " +
    "using ONLY the evidence given: the spoken transcript and the camera-frame observations (labels, on-screen text, recognised public figures). " +
    "Do not invent names, scores or events that the evidence does not support. Reply with JSON only: " +
    '{"segments":[{"i":<number>,"title":"<max 8 words>","description":"<1-2 sentences, concrete: who/what/action>",' +
    '"type":"<short snake_case moment type, e.g. goal, chance, save, foul, celebration, replay, interview, crowd, kickoff, dialogue, action, establishing, reveal, talk, audience, applause, slide, step, ingredient, result, intro, outro, other>",' +
    '"people":["<names of people the evidence says are present or talked about>"]}]}';
  const items: Described[] = [];
  for (let b = 0; b < segs.length; b += 8) {
    const batch = segs.slice(b, b + 8).map((s, k) => ({
      i: b + k,
      time: `${formatMs(s.startMs)}–${formatMs(s.endMs)}`,
      transcript: s.transcript.slice(0, 900),
      labels: s.frame.labels.map((l) => l.name).slice(0, 10),
      onScreenText: s.frame.text.map((t) => t.text).slice(0, 8),
      publicFigures: s.frame.celebrities.filter((c) => c.confidence >= 90).map((c) => c.name),
    }));
    const user = `Video: "${meta.title}" (channel: ${meta.channel}).\nAbout: ${meta.description.slice(0, 600)}\n\nSegments:\n${JSON.stringify(batch)}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await model.complete(system, [{ role: "user", content: user }], []);
        const parsed = extractJson(r.text).segments as Described[];
        for (const it of parsed) if (typeof it.i === "number") items.push({ ...it, people: it.people ?? [] });
        log(`  described ${Math.min(b + 8, segs.length)}/${segs.length} (${r.model})`);
        break;
      } catch (e) {
        if (attempt >= 2) throw e;
        log(`  retry describe batch ${b}: ${(e as Error).message.slice(0, 100)}`);
      }
    }
  }
  return { model: model.label, items };
}

export async function buildVideoIndex(dataDir: string, contentId: string, embedder: Embedder = defaultEmbedder(), log: (s: string) => void = console.log): Promise<ContentIndex> {
  const dir = join(dataDir, "content", contentId);
  const video = join(dir, "video.mp4");
  const info = JSON.parse(readFileSync(join(dir, "video.info.json"), "utf8"));
  const meta = { title: info.title as string, channel: (info.channel ?? info.uploader) as string, description: (info.description ?? "") as string };
  const durationMs = Math.round(Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).toString()) * 1000);

  // Transcript: prefer the uploader's English subtitles, then YouTube's English auto-captions.
  const vtt = ["video.en.vtt", "video.en-orig.vtt", "video.en-US.vtt", "video.en-GB.vtt"].map((f) => join(dir, f)).find(existsSync);
  const transcript: TranscriptLine[] = vtt ? parseVtt(readFileSync(vtt, "utf8")) : [];

  const shots = await cached(dir, "shots", async () => {
    // Shot detection only needs pixels and timing: upload a small video-only H.264 proxy, not the master.
    const proxy = join(dir, "analysis", "proxy.mp4");
    mkdirSync(join(dir, "analysis"), { recursive: true });
    if (!existsSync(proxy)) execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", video, "-an", "-vf", "scale=640:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", proxy]);
    log(`  uploading ${(statSync(proxy).size / 1e6).toFixed(1)} MB proxy to s3://${BUCKET}`);
    await uploadOnce(BUCKET, `content/${contentId}/proxy.mp4`, proxy);
    return detectShots(BUCKET, `content/${contentId}/proxy.mp4`, String(statSync(proxy).size), (s) => log(`  segment detection: ${s}`));
  }, log);
  const ranges = shotsToSegments(shots, durationMs);

  const frames = await cached(dir, "frames", async () => {
    const out: FrameAnalysis[] = [];
    for (const r of ranges) {
      const at = Math.round((r.startMs + r.endMs) / 2);
      out.push(await analyzeFrame(keyframe(video, at), at));
      if (out.length % 10 === 0) log(`  rekognition ${out.length}/${ranges.length}`);
    }
    return out;
  }, log);

  const txIn = (a: number, b: number) => transcript.filter((l) => l.endMs > a && l.startMs < b).map((l) => l.text).join(" ");
  const segInputs = ranges.map((r, i) => ({ ...r, transcript: txIn(r.startMs, r.endMs), frame: frames[i] }));
  const described = await cached(dir, "describe", () => describeSegments(meta, segInputs, log), log);

  // People: Rekognition celebrity matches (≥ 90%) and names the description grounded in the evidence.
  const people = new Map<string, { name: string; segs: Set<number>; source: Set<string>; urls: string[] }>();
  const addPerson = (name: string, i: number, source: string, urls: string[] = []) => {
    const id = `person:${slug(name)}`;
    if (!slug(name)) return;
    const p = people.get(id) ?? { name, segs: new Set<number>(), source: new Set<string>(), urls };
    p.segs.add(i);
    p.source.add(source);
    people.set(id, p);
  };
  // Face matches alone produce look-alike false positives (e.g. NFL players in a football crowd), so a
  // celebrity enters the index only when corroborated: ≥ 99% match, seen in ≥ 2 segments, or named (full name) in speech.
  const spoken = transcript.map((l) => l.text.toLowerCase()).join(" ");
  const hits = new Map<string, number[]>();
  frames.forEach((f, i) => f.celebrities.filter((c) => c.confidence >= 90).forEach((c) => hits.set(c.name, [...(hits.get(c.name) ?? []), i])));
  frames.forEach((f, i) =>
    f.celebrities
      .filter((c) => c.confidence >= 90)
      .filter((c) => c.confidence >= 99 || new Set(hits.get(c.name)).size >= 2 || spoken.includes(c.name.toLowerCase()))
      .forEach((c) => addPerson(c.name, i, "amazon-rekognition RecognizeCelebrities", c.urls)),
  );
  for (const d of described.items) for (const n of d.people) addPerson(n, d.i, "llm-description");

  const entities: Entity[] = [...people.entries()].map(([id, p]) => {
    const parts = p.name.split(/\s+/);
    return {
      id,
      type: "person",
      name: p.name,
      aliases: parts.length > 1 ? [parts[parts.length - 1]] : [],
      description: `Appears in ${p.segs.size} segment${p.segs.size > 1 ? "s" : ""}; identified by ${[...p.source].join(" + ")}${p.urls[0] ? ` (${p.urls[0]})` : ""}.`,
    };
  });

  const events: ProviderEvent[] = [];
  const segments: Segment[] = [];
  const presence: NonNullable<ContentIndex["presence"]> = [];
  const signs: NonNullable<ContentIndex["signs"]> = [];
  ranges.forEach((r, i) => {
    const d = described.items.find((x) => x.i === i) ?? { i, title: formatMs(r.startMs), description: "", type: "other", people: [] };
    const f = frames[i];
    const ids = [...people.entries()].filter(([, p]) => p.segs.has(i)).map(([id]) => id);
    const tx = segInputs[i].transcript;
    const ocr = f.text.map((t) => t.text);
    events.push({ id: `seg-${i + 1}`, type: d.type || "other", startMs: r.startMs, endMs: r.endMs, description: d.description || d.title, players: [], entityIds: ids, title: d.title });
    segments.push({
      id: `seg-v-${i + 1}`,
      contentId,
      kind: "event",
      startMs: r.startMs,
      endMs: r.endMs,
      eventId: `seg-${i + 1}`,
      eventType: d.type || "other",
      label: d.title || formatMs(r.startMs),
      text: [d.title, d.description, d.type.replace(/_/g, " "), ids.map((id) => people.get(id)!.name).join(", "), `Seen: ${f.labels.map((l) => l.name).join(", ")}`, ocr.length ? `On screen: ${ocr.join(" / ")}` : "", tx].filter(Boolean).join(". "),
      transcript: tx,
      entityIds: ids,
      screenText: ocr,
      provenance: [
        { source: "amazon-rekognition", confidence: 1, epistemicType: "observed", privacy: "content_metadata" },
        { source: described.model, confidence: 0.8, epistemicType: "inferred", privacy: "content_metadata", spoilerScope: "safe_before_playhead" },
        { source: vtt ? "youtube-captions" : "none", confidence: 0.9, epistemicType: "observed", privacy: "content_metadata" },
      ],
    });
    for (const id of ids) presence.push({ startMs: r.startMs, endMs: r.endMs, entityId: id, name: people.get(id)!.name });
    if (ocr.length) signs.push({ startMs: r.startMs, endMs: r.endMs, text: ocr.join(" / "), kind: "on-screen text" });
  });

  log(`embedding ${segments.length} segments with ${embedder.model}…`);
  const vectors = await embedder.embed(segments.map((s) => s.text), "index");
  segments.forEach((s, i) => (s.embedding = vectors[i]));

  return {
    contentId,
    title: meta.title,
    kind: "video",
    durationMs,
    media: "video.mp4",
    builtAt: new Date().toISOString(),
    embeddingModel: embedder.model,
    embeddingDim: embedder.dim || vectors[0]?.length || 0,
    sources: {
      provider: `YouTube · ${meta.channel} · ${info.license ?? "license not stated"} · ${info.webpage_url}`,
      transcript: vtt ? "youtube-captions" : "none",
      screenText: "amazon-rekognition DetectText",
      shots: "amazon-rekognition StartSegmentDetection",
      vision: "amazon-rekognition DetectLabels + RecognizeCelebrities",
      descriptions: described.model,
      embeddings: embedder.model,
    },
    entities,
    events,
    transcript,
    segments,
    scoreboard: [],
    possession: [],
    touches: [],
    teams: [],
    signs,
    presence,
  };
}

if (process.argv[1]?.endsWith("ingest-video.ts")) {

  const ids = process.argv.slice(2);
  const dataDir = process.env.SP_DATA_DIR ?? "data";
  for (const id of ids) {
    const index = await buildVideoIndex(dataDir, id);
    mkdirSync(join(dataDir, "index"), { recursive: true });
    writeFileSync(join(dataDir, "index", `${id}.json`), JSON.stringify(index));
    const types = index.events.reduce<Record<string, number>>((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {});
    console.log(`indexed ${id}: ${index.segments.length} segments ${JSON.stringify(types)}, ${index.entities.length} people, embeddings=${index.embeddingModel}(${index.embeddingDim})`);
  }
}
