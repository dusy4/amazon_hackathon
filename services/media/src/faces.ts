/**
 * Characters in films: an Amazon Rekognition face collection per title.
 *
 * RecognizeCelebrities only knows public figures; the cast of most films (and every animated or indie title)
 * is unknown to it. So, per title:
 *   1. sample a frame every 2 s and IndexFaces into the title's own collection (ExternalImageId = time),
 *   2. cluster faces with SearchFaces (same person across shots),
 *   3. name each cluster from the scenes it appears in: the character name whose segments the cluster
 *      over-represents (lift), each name used once,
 *   4. at "who is she?", SearchFacesByImage on the paused frame against this collection → cluster → name.
 *
 *   npx tsx services/media/src/faces.ts yt-tears-of-steel
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  CreateCollectionCommand,
  IndexFacesCommand,
  RekognitionClient,
  SearchFacesByImageCommand,
  SearchFacesCommand,
} from "@aws-sdk/client-rekognition";
import type { ContentIndex } from "../../../packages/contracts/src/index.ts";

const region = () => process.env.AWS_REGION ?? "us-east-1";
export const collectionFor = (contentId: string) => `semantic-playback-${contentId}`;

export interface FaceCluster {
  id: string;
  name: string | null;
  actor?: string | null;
  entityId: string | null;
  faceIds: string[];
  appearances: number[]; // ms
  score: number; // naming lift
}

function frameAt(video: string, ms: number): Uint8Array {
  return execFileSync("ffmpeg", ["-loglevel", "error", "-ss", (ms / 1000).toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=960:-1", "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "-"], { maxBuffer: 16 << 20 });
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

export async function buildFaceIndex(dataDir: string, contentId: string, stepMs = 2000, log = console.log) {
  const rk = new RekognitionClient({ region: region() });
  const dir = join(dataDir, "content", contentId);
  const cache = join(dir, "analysis", "faces.json");
  const idxPath = join(dataDir, "index", `${contentId}.json`);
  const index: ContentIndex = JSON.parse(readFileSync(idxPath, "utf8"));
  const video = existsSync(join(dir, "analysis", "proxy.mp4")) ? join(dir, "analysis", "proxy.mp4") : join(dir, "video.mp4");
  const collection = collectionFor(contentId);

  let faces: { faceId: string; atMs: number; confidence: number; box: unknown }[];
  if (existsSync(cache)) faces = JSON.parse(readFileSync(cache, "utf8")).faces;
  else {
    try {
      await rk.send(new CreateCollectionCommand({ CollectionId: collection }));
      log(`created collection ${collection}`);
    } catch (e) {
      if (!/AlreadyExists/.test((e as Error).name ?? "")) throw e;
    }
    const times = Array.from({ length: Math.floor(index.durationMs / stepMs) }, (_, i) => i * stepMs + stepMs / 2);
    log(`indexing faces in ${times.length} frames (every ${stepMs / 1000} s)…`);
    const per = await pool(times, 4, async (ms) => {
      const r = await rk.send(new IndexFacesCommand({
        CollectionId: collection, Image: { Bytes: frameAt(video, ms) }, ExternalImageId: `t${ms}`, MaxFaces: 6, QualityFilter: "AUTO",
      }));
      return (r.FaceRecords ?? []).map((f) => ({ faceId: f.Face!.FaceId!, atMs: ms, confidence: f.Face!.Confidence ?? 0, box: f.Face!.BoundingBox }));
    });
    faces = per.flat();
    mkdirSync(join(dir, "analysis"), { recursive: true });
    writeFileSync(cache, JSON.stringify({ collection, stepMs, faces }));
    log(`indexed ${faces.length} faces`);
  }

  // Cluster: union-find over SearchFaces matches.
  const parent = new Map(faces.map((f) => [f.faceId, f.faceId]));
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  const known = new Set(faces.map((f) => f.faceId));
  await pool(faces, 4, async (f) => {
    const r = await rk.send(new SearchFacesCommand({ CollectionId: collection, FaceId: f.faceId, FaceMatchThreshold: 90, MaxFaces: 200 }));
    for (const m of r.FaceMatches ?? []) {
      const id = m.Face?.FaceId;
      if (id && known.has(id)) parent.set(find(id), find(f.faceId));
    }
  });
  const groups = new Map<string, typeof faces>();
  for (const f of faces) groups.set(find(f.faceId), [...(groups.get(find(f.faceId)) ?? []), f]);
  const clusters = [...groups.values()].filter((g) => new Set(g.map((f) => f.atMs)).size >= 3).sort((a, b) => b.length - a.length);
  log(`${clusters.length} people seen in ≥ 3 frames`);

  // Name clusters by lift: which character's segments does this face over-represent?
  const people = index.entities.filter((e) => e.type === "person" || e.type === "character");
  const segs = index.segments;
  const segAt = (ms: number) => segs.filter((s) => s.startMs <= ms && ms < s.endMs);
  const base = new Map(people.map((p) => [p.id, segs.filter((s) => s.entityIds.includes(p.id)).reduce((a, s) => a + (s.endMs - s.startMs), 0) / index.durationMs]));
  const candidates: { c: number; id: string; lift: number; hits: number }[] = [];
  clusters.forEach((g, c) => {
    const times = [...new Set(g.map((f) => f.atMs))];
    for (const p of people) {
      const hits = times.filter((ms) => segAt(ms).some((s) => s.entityIds.includes(p.id))).length;
      const b = base.get(p.id) || 0;
      if (hits >= 2 && b > 0) candidates.push({ c, id: p.id, lift: hits / times.length / b, hits });
    }
  });
  candidates.sort((a, b) => b.lift * Math.sqrt(b.hits) - a.lift * Math.sqrt(a.hits));
  const named = new Map<number, { id: string; lift: number }>();
  const used = new Set<string>();
  for (const k of candidates) {
    if (named.has(k.c) || used.has(k.id) || k.lift < 1.5) continue;
    named.set(k.c, { id: k.id, lift: k.lift });
    used.add(k.id);
  }
  // A provider cast list (one reference face per character) wins over lift: two characters who are always on
  // screen together (a couple) have the same scene co-occurrence, and lift alone swaps them.
  const castPath = join(dir, "cast.json");
  const cast = existsSync(castPath) ? (JSON.parse(readFileSync(castPath, "utf8")).characters as { name: string; entityId: string; faceId: string; actor?: string }[]) : null;
  if (cast) {
    named.clear();
    clusters.forEach((g, c) => {
      const hit = cast.find((x) => g.some((f) => f.faceId === x.faceId));
      if (hit) named.set(c, { id: hit.entityId, lift: 0 });
    });
    log(`named from cast list (${cast.length} characters)`);
  }
  const out: FaceCluster[] = clusters.map((g, c) => {
    const n = named.get(c);
    const e = n ? people.find((p) => p.id === n.id)! : null;
    const castHit = cast?.find((x) => x.entityId === n?.id);
    return { id: `face-${c + 1}`, name: castHit?.name ?? e?.name ?? null, actor: castHit?.actor ?? null, entityId: e?.id ?? null, faceIds: g.map((f) => f.faceId), appearances: [...new Set(g.map((f) => f.atMs))].sort((a, b) => a - b), score: +(n?.lift ?? 0).toFixed(2) };
  });
  for (const c of out) log(`  ${c.id}: ${c.appearances.length} frames → ${c.name ?? "unnamed"} (lift ${c.score})`);

  // Store on the index: the collection, the clusters, and presence spans for named people.
  (index as any).faces = { collection, method: `amazon-rekognition IndexFaces + SearchFaces; names from ${cast ? "the cast list" : "scene lift"}`, clusters: out };
  const faceIds = new Set(out.map((c) => c.entityId).filter(Boolean));
  index.presence = (index.presence ?? []).filter((p) => !(p as any).fromFaces);
  const presence = index.presence;
  for (const c of out.filter((x) => x.entityId)) {
    let start = c.appearances[0], prev = start;
    for (const ms of [...c.appearances.slice(1), Infinity]) {
      if (ms - prev > 6000) {
        presence.push({ startMs: Math.max(0, start - 1000), endMs: prev + 1000, entityId: c.entityId!, name: c.name!, fromFaces: true } as any);
        start = ms;
      }
      prev = ms;
    }
  }
  writeFileSync(idxPath, JSON.stringify(index));
  return out;
}

/** "Who is she?": the paused frame's faces against this title's own collection. */
export async function identifyInCollection(index: ContentIndex, jpeg: Uint8Array) {
  const f = (index as any).faces as { collection: string; clusters: FaceCluster[] } | undefined;
  if (!f) return null;
  const rk = new RekognitionClient({ region: region() });
  try {
    const r = await rk.send(new SearchFacesByImageCommand({ CollectionId: f.collection, Image: { Bytes: jpeg }, FaceMatchThreshold: 88, MaxFaces: 10 }));
    for (const m of r.FaceMatches ?? []) {
      const c = f.clusters.find((x) => x.faceIds.includes(m.Face?.FaceId ?? ""));
      if (c?.name) return { cluster: c, similarity: Math.round(m.Similarity ?? 0) };
    }
  } catch (e) {
    if (/no faces|InvalidParameter/i.test((e as Error).message)) return null; // no face in the paused frame
    throw e;
  }
  return null;
}

/**
 * Without Rekognition access: the named character whose face was sampled closest to `atMs` when the face index
 * was built (faces are sampled every `stepMs`, ~2 s), within `windowMs`.
 */
export function identifyFromIngest(index: ContentIndex, atMs: number, windowMs = 2000) {
  const f = (index as any).faces as { clusters: FaceCluster[] } | undefined;
  let best: { cluster: FaceCluster; distanceMs: number } | null = null;
  for (const cluster of f?.clusters ?? []) {
    if (!cluster.name) continue;
    for (const ms of cluster.appearances) {
      const distanceMs = Math.abs(ms - atMs);
      if (distanceMs <= windowMs && (!best || distanceMs < best.distanceMs)) best = { cluster, distanceMs };
    }
  }
  return best;
}

if (process.argv[1]?.endsWith("faces.ts")) {
  for (const id of process.argv.slice(2)) await buildFaceIndex(process.env.SP_DATA_DIR ?? "data", id);
}
