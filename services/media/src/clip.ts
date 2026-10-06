/**
 * Server-side semantic clipping (v2 "Clips and distribution").
 *
 * Production path in v2: MediaConvert input clipping + graphic overlay. This implementation
 * renders the same job shape locally with ffmpeg (input clipping + watermark + attribution bar),
 * because it needs no AWS account and returns in ~1–2 s for short clips. `toMediaConvertInput`
 * shows the equivalent MediaConvert InputClippings for the same request.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatMs } from "../../../packages/contracts/src/index.ts";

export interface ClipJob {
  clipId: string;
  inputPath: string;
  outDir: string;
  startMs: number;
  endMs: number;
  label: string;
  attribution: string;
}

const FONT = process.platform === "win32" ? "C\\:/Windows/Fonts/arialbd.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

/** drawtext-safe text: strip characters that need filter-graph escaping. */
const safe = (s: string) => s.replace(/[:'%\\,;\[\]=]/g, " ").replace(/\s+/g, " ").trim();

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-600)}`))));
  });
}

export async function renderClip(job: ClipJob) {
  if (!existsSync(job.outDir)) mkdirSync(job.outDir, { recursive: true });
  const t0 = Date.now();
  const out = join(job.outDir, `${job.clipId}.mp4`);
  const thumb = join(job.outDir, `${job.clipId}.jpg`);
  const dur = Math.max(0.5, (job.endMs - job.startMs) / 1000);
  const vf = [
    `drawbox=x=0:y=ih-64:w=iw:h=64:color=black@0.72:t=fill`,
    `drawtext=fontfile='${FONT}':text='${safe(job.label)}':x=24:y=h-52:fontsize=26:fontcolor=white`,
    `drawtext=fontfile='${FONT}':text='${safe(job.attribution)}':x=24:y=h-22:fontsize=16:fontcolor=0xcbd5e1`,
    `drawtext=fontfile='${FONT}':text='SEMANTIC PLAYBACK':x=w-tw-24:y=h-44:fontsize=20:fontcolor=0xfbbf24`,
  ].join(",");
  await run([
    "-y", "-loglevel", "error",
    "-ss", (job.startMs / 1000).toFixed(3), "-i", job.inputPath, "-t", dur.toFixed(3),
    "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", out,
  ]);
  await run(["-y", "-loglevel", "error", "-ss", (dur / 2).toFixed(2), "-i", out, "-frames:v", "1", "-vf", "scale=480:-1", thumb]);
  return { out, thumb, renderMs: Date.now() - t0, renderer: "ffmpeg (local, MediaConvert-equivalent job)" };
}

/** The equivalent AWS Elemental MediaConvert input definition for the same clip request. */
export function toMediaConvertInput(s3Uri: string, startMs: number, endMs: number, fps = 25) {
  const tc = (ms: number) => {
    const f = Math.round((ms / 1000) * fps);
    const hh = Math.floor(f / (3600 * fps));
    const mm = Math.floor((f / (60 * fps)) % 60);
    const ss = Math.floor((f / fps) % 60);
    const ff = f % fps;
    return [hh, mm, ss, ff].map((n) => String(n).padStart(2, "0")).join(":");
  };
  return { FileInput: s3Uri, TimecodeSource: "ZEROBASED", InputClippings: [{ StartTimecode: tc(startMs), EndTimecode: tc(endMs) }] };
}

export const clipAttribution = (title: string, startMs: number) => `${title} - watch the full match from ${formatMs(startMs)}`;
