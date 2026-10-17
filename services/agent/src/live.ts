/**
 * Live sports layer on Amazon IVS.
 *
 * A match is pushed to an IVS low-latency channel (RTMPS ingest). As the broadcast reaches each goal in the
 * title's index, the server calls IVS PutMetadata; IVS stamps the payload into the stream as ID3 timed
 * metadata, so every viewer's player receives it on the same frame. The Fire OS app reads the cue
 * (ExoPlayer onMetadata), shows a LIVE banner and reports it here; the agent then offers a replay, and
 * "show me that goal" replays it from the build-up while the channel keeps going.
 *
 * Feasibility A: official IVS APIs (CreateChannel, PutMetadata) + ExoPlayer HLS ID3.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { IvsClient, PutMetadataCommand } from "@aws-sdk/client-ivs";
import type { ContentIndex } from "../../../packages/contracts/src/index.ts";

export interface LiveCue {
  t: string; // event type
  title: string;
  src: string; // contentId of the source title (for replays)
  ms: number; // where the moment starts in the source (build-up included)
  at: number; // broadcast position of the marker in the source
}

export class LiveChannel {
  readonly playbackUrl = process.env.SP_IVS_PLAYBACK ?? "";
  /** What the TV loads: the IVS URL, or the server relay when SP_IVS_RELAY=1 (emulator without internet). */
  get tvUrl() {
    return process.env.SP_IVS_RELAY === "1" ? `/live-proxy?u=${encodeURIComponent(this.playbackUrl)}` : this.playbackUrl;
  }
  private ivs = new IvsClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  private proc: ChildProcess | null = null;
  private timers: NodeJS.Timeout[] = [];
  sent: (LiveCue & { sentAt: string })[] = [];
  received: (LiveCue & { receivedAt: string })[] = [];
  source: { contentId: string; title: string; fromMs: number; startedAt: number } | null = null;

  get configured() {
    return !!(process.env.SP_IVS_CHANNEL_ARN && process.env.SP_IVS_INGEST && process.env.SP_IVS_STREAM_KEY && this.playbackUrl);
  }
  get active() {
    return !!this.proc;
  }

  /** Goals in the index, one per goal (repeated descriptions of the same goal collapse to the first). */
  static markers(index: ContentIndex): LiveCue[] {
    const goals = index.events.filter((e) => e.type === "goal").sort((a, b) => a.startMs - b.startMs);
    // One goal is often described several times in a row; group them and keep the description that names
    // the most people (the scorer, not just the keeper), timed when that description's commentary calls it.
    const groups: (typeof goals)[] = [];
    for (const g of goals) {
      const last = groups[groups.length - 1];
      if (last && g.startMs - last[0].startMs < 30_000) last.push(g);
      else groups.push([g]);
    }
    return groups.map((grp) => {
      const g = [...grp].sort((a, b) => (b.entityIds?.length ?? 0) - (a.entityIds?.length ?? 0) || a.startMs - b.startMs)[0];
      return { t: "goal", title: g.title ?? "Goal", src: index.contentId, ms: g.startMs, at: (g as any).captionedStartMs ?? g.startMs };
    });
  }

  start(index: ContentIndex, mediaPath: string, fromMs: number, log = console.log) {
    if (!this.configured) throw new Error("IVS channel not configured (SP_IVS_* in .env)");
    this.stop();
    this.sent = [];
    this.received = [];
    const url = `rtmps://${process.env.SP_IVS_INGEST}:443/app/${process.env.SP_IVS_STREAM_KEY}`;
    // Real-time push of the match: 720p H.264, 2 s keyframes (IVS low-latency recommendation), AAC.
    this.proc = spawn("ffmpeg", [
      "-loglevel", "error", "-re", "-ss", (fromMs / 1000).toFixed(2), "-i", mediaPath,
      "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k",
      "-g", "50", "-keyint_min", "50", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
      "-f", "flv", url,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    this.proc.stderr?.on("data", (d) => log(`[ivs ffmpeg] ${String(d).trim().slice(0, 200)}`));
    this.proc.on("exit", () => (this.proc = null));
    this.source = { contentId: index.contentId, title: index.title, fromMs, startedAt: Date.now() };
    for (const m of LiveChannel.markers(index).filter((m) => m.at > fromMs)) {
      this.timers.push(setTimeout(() => void this.mark(m, log), m.at - fromMs));
    }
    log(`[ivs] live from ${Math.round(fromMs / 1000)} s; ${this.timers.length} goal markers scheduled`);
  }

  private async mark(m: LiveCue, log: (s: string) => void) {
    try {
      await this.ivs.send(new PutMetadataCommand({ channelArn: process.env.SP_IVS_CHANNEL_ARN!, metadata: JSON.stringify(m) }));
      this.sent.push({ ...m, sentAt: new Date().toISOString() });
      log(`[ivs] PutMetadata ${m.t}: ${m.title}`);
    } catch (e) {
      log(`[ivs] PutMetadata failed: ${(e as Error).message}`);
    }
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.proc?.kill("SIGINT");
    this.proc = null;
  }

  /** Position in the source the broadcast is at now (for "back to live"). */
  positionNow() {
    return this.source ? this.source.fromMs + (Date.now() - this.source.startedAt) : 0;
  }
}

export const live = new LiveChannel();
