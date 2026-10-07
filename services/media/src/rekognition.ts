/**
 * Amazon Rekognition for real footage (v2 "selective Rekognition").
 *
 *  - shots(): Rekognition Video StartSegmentDetection (SHOT) on the video in S3 → shot boundaries.
 *  - analyzeFrame(): one keyframe per segment → DetectLabels (objects/scene), DetectText (on-screen text,
 *    LINE level) and RecognizeCelebrities (public figures, with confidence).
 */
import { readFileSync } from "node:fs";
import {
  DetectLabelsCommand,
  DetectTextCommand,
  GetSegmentDetectionCommand,
  RecognizeCelebritiesCommand,
  RekognitionClient,
  StartSegmentDetectionCommand,
} from "@aws-sdk/client-rekognition";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const region = () => process.env.AWS_REGION ?? "us-east-1";

export interface Shot {
  startMs: number;
  endMs: number;
  confidence: number;
}

export interface FrameAnalysis {
  atMs: number;
  labels: { name: string; confidence: number }[];
  text: { text: string; confidence: number }[];
  celebrities: { name: string; id: string; confidence: number; urls: string[] }[];
}

export async function uploadOnce(bucket: string, key: string, path: string) {
  const s3 = new S3Client({ region: region() });
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { bucket, key, uploaded: false };
  } catch {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: readFileSync(path), ContentType: "video/mp4" }));
    return { bucket, key, uploaded: true };
  }
}

/** `fingerprint` (e.g. file size) is part of the idempotency token, so a re-encoded file gets a new job. */
export async function detectShots(bucket: string, key: string, fingerprint: string, onWait?: (s: string) => void): Promise<Shot[]> {
  const rk = new RekognitionClient({ region: region() });
  const { JobId } = await rk.send(
    new StartSegmentDetectionCommand({ Video: { S3Object: { Bucket: bucket, Name: key } }, SegmentTypes: ["SHOT"], ClientRequestToken: `${key}-${fingerprint}`.replace(/[^a-zA-Z0-9-_]/g, "").slice(-64) }),
  );
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const shots: Shot[] = [];
    let token: string | undefined;
    let status = "";
    do {
      const r = await rk.send(new GetSegmentDetectionCommand({ JobId, NextToken: token, MaxResults: 1000 }));
      status = r.JobStatus ?? "";
      if (status !== "SUCCEEDED") break;
      for (const s of r.Segments ?? []) shots.push({ startMs: s.StartTimestampMillis ?? 0, endMs: s.EndTimestampMillis ?? 0, confidence: s.ShotSegment?.Confidence ?? 0 });
      token = r.NextToken;
    } while (token);
    if (status === "SUCCEEDED") return shots;
    if (status === "FAILED") throw new Error(`Rekognition segment detection failed for ${key}`);
    onWait?.(status);
  }
}

export async function analyzeFrame(jpeg: Uint8Array, atMs: number): Promise<FrameAnalysis> {
  const rk = new RekognitionClient({ region: region() });
  const [labels, text, celebs] = await Promise.all([
    rk.send(new DetectLabelsCommand({ Image: { Bytes: jpeg }, MaxLabels: 12, MinConfidence: 70 })),
    rk.send(new DetectTextCommand({ Image: { Bytes: jpeg } })),
    rk.send(new RecognizeCelebritiesCommand({ Image: { Bytes: jpeg } })),
  ]);
  return {
    atMs,
    labels: (labels.Labels ?? []).map((l) => ({ name: l.Name ?? "", confidence: Math.round(l.Confidence ?? 0) })),
    text: (text.TextDetections ?? []).filter((t) => t.Type === "LINE" && (t.Confidence ?? 0) >= 85).map((t) => ({ text: t.DetectedText ?? "", confidence: Math.round(t.Confidence ?? 0) })),
    celebrities: (celebs.CelebrityFaces ?? []).map((c) => ({ name: c.Name ?? "", id: c.Id ?? "", confidence: Math.round(c.MatchConfidence ?? 0), urls: c.Urls ?? [] })),
  };
}
