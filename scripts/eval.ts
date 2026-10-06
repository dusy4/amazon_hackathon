/**
 * Offline eval: run the golden set through the real stack (orchestrator → MCP → headless player) with
 * whatever interpreter/embeddings .env configures, and score it.
 *
 *   npm run eval                    # configured interpreter (e.g. SP_LLM=openrouter)
 *   SP_LLM= npm run eval            # rules-only baseline
 *
 * Metrics: seek hit-rate (player ends inside an acceptable target segment), temporal IoU of the landed
 * segment, spoiler-guard accuracy, answer accuracy, latency. Results → evals/results/<label>.json.
 */
import "dotenv/config";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../services/agent/src/main.ts";
import { SimPlayer } from "../tests/helpers/sim-player.ts";

interface Case {
  id: string;
  content: string;
  playheadMs: number;
  utterance: string;
  targets?: string[];
  offsetMs?: number;
  rate?: number;
  speech?: string;
  expect?: "spoiler";
}

const golden: { cases: Case[] } = JSON.parse(readFileSync("evals/golden.json", "utf8"));
const only = process.argv[2];
const dataDir = mkdtempSync(join(tmpdir(), "sp-eval-"));
cpSync("data/index", join(dataDir, "index"), { recursive: true });
cpSync("data/content", join(dataDir, "content"), { recursive: true });
process.env.SP_MEMORY = "file";
const srv = await startServer({ port: 8797, dataDir, host: "127.0.0.1" });
const player = new SimPlayer();
await player.connect("ws://127.0.0.1:8797/ws");

const rows: Record<string, unknown>[] = [];
for (const c of golden.cases.filter((x) => !only || x.id.includes(only))) {
  const idx = srv.app.store.get(c.content)!;
  // Fresh viewing state per case: load the title, reset references, watch up to the playhead.
  await srv.app.bridge.send({ cmd: "load", contentId: idx.contentId, url: `/media/${idx.contentId}/${idx.media}` });
  const s = srv.app.sessions.get();
  s.contentId = null;
  s.setContent(idx.contentId);
  s.watchedUpToMs = 0;
  s.spoilerMode = "strict";
  player.state = { ...player.state, contentId: idx.contentId, positionMs: 0, rate: 1, loop: null, segment: null };
  await player.playTo(c.playheadMs);
  const before = player.state.positionMs;

  const t = await srv.orchestrator.handle(c.utterance, { inputSource: "eval" });
  const pos = player.state.positionMs;
  let pass = false;
  let detail = "";
  let iou: number | null = null;
  if (c.expect === "spoiler") {
    pass = pos <= Math.max(before, c.playheadMs) + 1000 && /spoil|haven'?t|not yet|hasn'?t happened|ahead of where/i.test(t.speech);
    detail = pass ? "guarded" : `pos ${pos}`;
  } else if (c.targets) {
    const segs = c.targets.map((id) => idx.segments.find((x) => x.eventId === id)).filter(Boolean) as typeof idx.segments;
    const off = c.offsetMs ?? 0;
    const hit = segs.find((g) => pos >= g.startMs + off - 1500 && pos <= g.endMs + off);
    pass = !!hit && (c.rate == null || Math.abs(player.state.rate - c.rate) < 0.01);
    // IoU between the landed moment (grounded segment) and the best target.
    const landed = s.activeMoment;
    if (landed) iou = Math.max(...segs.map((g) => Math.max(0, Math.min(g.endMs, landed.endMs) - Math.max(g.startMs, landed.startMs)) / (Math.max(g.endMs, landed.endMs) - Math.min(g.startMs, landed.startMs))));
    detail = hit ? `in ${hit.eventId}` : `pos ${pos}`;
  } else if (c.speech) {
    pass = new RegExp(c.speech, "i").test(t.speech);
  }
  const tools = t.trace.filter((x) => x.kind === "tool_call").map((x) => x.label);
  rows.push({ id: c.id, pass, detail, iou: iou == null ? null : +iou.toFixed(2), ms: t.durationMs, interpreter: t.interpreter, tools, speech: t.speech });
  console.log(`${pass ? "PASS" : "FAIL"}  ${c.id.padEnd(22)} ${String(t.durationMs).padStart(6)}ms  ${t.interpreter.padEnd(28)} ${detail.padEnd(10)} ${t.speech.slice(0, 90)}`);
}

const seek = rows.filter((r) => golden.cases.find((c) => c.id === r.id)?.targets);
const ious = seek.map((r) => r.iou as number | null).filter((x): x is number => x != null);
const summary = {
  label: srv.orchestrator.interpreterName,
  at: new Date().toISOString(),
  cases: rows.length,
  passRate: +(rows.filter((r) => r.pass).length / rows.length).toFixed(3),
  seekHitRate: +(seek.filter((r) => r.pass).length / Math.max(1, seek.length)).toFixed(3),
  "R1@IoU0.5": +(ious.filter((x) => x >= 0.5).length / Math.max(1, seek.length)).toFixed(3),
  "R1@IoU0.7": +(ious.filter((x) => x >= 0.7).length / Math.max(1, seek.length)).toFixed(3),
  medianMs: rows.map((r) => r.ms as number).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
};
console.log(JSON.stringify(summary, null, 2));
mkdirSync("evals/results", { recursive: true });
writeFileSync(`evals/results/${summary.label.replace(/[^a-z0-9.-]+/gi, "_")}.json`, JSON.stringify({ summary, rows }, null, 2));

player.close();
await srv.close();
rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
