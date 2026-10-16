/**
 * Demo recorder: drives scripted scenes against the running server + the active player (the Fire OS
 * app on a Fire TV / Android TV emulator), screen-records the device with `adb screenrecord`, and saves
 * every turn's real trace with its timestamp inside the recording.
 *
 *   npm start                          # server, with the Fire OS app connected as the active player
 *   npx tsx scripts/demo-video/record.ts [outDir]
 *   python scripts/demo-video/compose.py [outDir]   # → demo-draft.mp4
 *
 * Nothing here is staged: utterances go through /api/utterance exactly as typed/spoken input would.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.SP_BASE ?? "http://127.0.0.1:8787";
const outDir = process.argv[2] ?? "artifacts/demo";
mkdirSync(outDir, { recursive: true });

type Step =
  | { say: string; holdMs?: number }
  /** Seek, play, then wait until the player itself reports `untilMs` (emulators decode slower than real time). */
  | { seek: number; play?: boolean; untilMs?: number; holdMs?: number }
  | { waitMs: number }
  | { open: string }
  | { setup: Record<string, unknown> };
interface Scene {
  id: string;
  title: string;
  steps: Step[];
}

const SCENES: Scene[] = [
  {
    id: "s1-north-star",
    title: "Go back to what I mean",
    steps: [
      { open: "harbor-v-northgate" },
      { setup: { spoilerMode: "strict" } },
      { seek: 86000, play: true, untilMs: 112000 }, // goal 1 happens live, celebration, replay plays
      { say: "Go back to the replay of that goal", holdMs: 4000 },
      { say: "Three seconds earlier", holdMs: 2500 },
      { say: "Half speed", holdMs: 2500 },
      { say: "Repeat it twice", holdMs: 9000 },
      { say: "Clip that and send it to my phone", holdMs: 5000 },
    ],
  },
  {
    id: "s2-entities",
    title: "Who is that — and show me his shots",
    steps: [
      { say: "Normal speed", holdMs: 1500 },
      { say: "Who is number 7?", holdMs: 5000 },
      { say: "Show me his shots", holdMs: 5000 },
      { say: "The second one", holdMs: 6000 },
    ],
  },
  {
    id: "s3-spoilers-catchup",
    title: "Spoiler-safe by construction",
    steps: [
      { say: "Show me the equaliser", holdMs: 5000 },
      { say: "Read the score", holdMs: 4000 },
      { say: "I was away for 2 minutes, catch me up", holdMs: 7000 },
      { say: "Who was the player I asked about?", holdMs: 5000 },
    ],
  },
  {
    id: "s4-real-footage",
    title: "Real footage: Tears of Steel (CC BY 3.0, Blender Foundation)",
    steps: [
      { say: "Play Tears of Steel", holdMs: 4000 },
      { seek: 548000, play: true, untilMs: 560000 }, // the viewer has watched up to 9:20
      { say: "Rewind to when they say there are two minutes left", holdMs: 6000 },
      { say: "When does the memory overwrite complete?", holdMs: 6000 },
      { say: "What's happening?", holdMs: 7000 }, // live Amazon Rekognition on the current frame
    ],
  },
];

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startRecording(remote: string) {
  // screenrecord stops at --time-limit (max 180 s) or when killed.
  return spawn("adb", ["shell", "screenrecord", "--time-limit", "180", "--bit-rate", "8000000", remote], { stdio: "ignore" });
}

async function stopRecording(proc: ReturnType<typeof spawn>, remote: string, local: string) {
  execFileSync("adb", ["shell", "pkill", "-INT", "screenrecord"]);
  await new Promise((r) => proc.on("close", r));
  await sleep(1500); // let the device finalise the mp4
  execFileSync("adb", ["pull", remote, local]);
  execFileSync("adb", ["shell", "rm", remote]);
}

const mcp = new Client({ name: "demo-recorder", version: "0.1.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
const health: any = await (await fetch(`${BASE}/api/health`)).json();
const active = health.players.find((p: { active: boolean }) => p.active);
if (!active) throw new Error("No active player — start the Fire OS app first.");
console.log(`recording on ${active.deviceId} (${active.kind}), interpreter=${health.interpreter}`);

// Optional scene filter: `record.ts <outDir> s4` records only scenes whose id contains "s4".
const only = process.argv[3];
const manifest: unknown[] = [];
for (const scene of SCENES.filter((s) => !only || s.id.includes(only))) {
  const remote = `/sdcard/${scene.id}.mp4`;
  const proc = startRecording(remote);
  await sleep(1200);
  const t0 = Date.now();
  const turns: unknown[] = [];
  for (const step of scene.steps) {
    if ("open" in step) {
      await mcp.callTool({ name: "content.open", arguments: { contentId: step.open } });
      await sleep(3000);
    } else if ("setup" in step) await post("/api/session", step.setup);
    else if ("waitMs" in step) await sleep(step.waitMs);
    else if ("seek" in step) {
      await mcp.callTool({ name: "player.seek", arguments: { positionMs: step.seek } });
      // Natural playback from here moves the spoiler boundary forward, as for a real viewer.
      await post("/api/session", { watchedUpToMs: step.seek });
      if (step.play) await mcp.callTool({ name: "player.play", arguments: {} });
      if (step.untilMs) {
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          const r = (await mcp.callTool({ name: "player.get_state", arguments: {} })) as { content: { text: string }[] };
          if (JSON.parse(r.content[0].text).positionMs >= step.untilMs) break;
          await sleep(500);
        }
      }
      await sleep(step.holdMs ?? 0);
    } else {
      const at = Date.now() - t0;
      const turn = await post("/api/utterance", { text: step.say, inputSource: "demo-script" });
      turns.push({ atMs: at, doneMs: Date.now() - t0, utterance: step.say, turn });
      console.log(`  [${scene.id} +${(at / 1000).toFixed(1)}s] ${step.say} → ${turn.speech} (${turn.interpreter}, ${turn.durationMs} ms)`);
      await sleep(step.holdMs ?? 3000);
    }
  }
  await sleep(1000);
  const local = join(outDir, `${scene.id}.mp4`);
  await stopRecording(proc, remote, local);
  manifest.push({ ...scene, video: `${scene.id}.mp4`, recordingStartOffsetMs: 1200, turns, device: active, interpreter: health.interpreter });
}
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
await mcp.close();
console.log(`saved ${manifest.length} scenes → ${outDir}/manifest.json`);
