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
import { join, resolve as resolvePath } from "node:path";
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
    id: "f1-football",
    title: "Real football: Soccer Aid 2023 (CC BY, Soccer Aid for UNICEF)",
    steps: [
      { open: "yt-soccer-aid-2023" },
      { setup: { spoilerMode: "strict" } },
      { seek: 128000, play: true, untilMs: 143000 }, // the viewer watches Usain Bolt score, then he turns to camera
      { say: "Who's this?", holdMs: 4500 }, // the lens freezes the frame, answers, and play resumes
      { say: "Read the score", holdMs: 4500 },
      { say: "Show me his goal", holdMs: 13000 }, // plays from the build-up: the ball goes in ~9 s later
      { say: "Go back five seconds in slow motion", holdMs: 11500 }, // the strike again, at half speed
      { say: "Normal speed", holdMs: 1500 },
      { say: "Clip that and send it to my phone", holdMs: 7000 },
    ],
  },
  {
    id: "f2-spoilers-memory",
    title: "Spoiler-safe, and it remembers",
    steps: [
      { seek: 222000, play: true, untilMs: 227000 }, // ordinary midfield play: nothing that could be mistaken for the goal
      { say: "Show me Robbie Keane's goal", holdMs: 6000 },
      { say: "Spoilers off", holdMs: 1500 },
      { say: "Show me Robbie Keane's goal", holdMs: 4500 }, // a long-range strike: in the net ~2.5 s after the jump
      { say: "Go back five seconds in slow motion", holdMs: 12000 },
      { say: "Normal speed", holdMs: 1000 },
      { say: "Spoilers on", holdMs: 2000 },
      { say: "I was away for 2 minutes, catch me up", holdMs: 9000 },
      { say: "Who was the player I asked about?", holdMs: 6500 },
    ],
  },
  {
    id: "s5-any-video",
    title: "Any video: a cooking video and a talk (CC BY)",
    steps: [
      { open: "yt-roti-recipe" },
      { seek: 184000, play: true, untilMs: 191000 },
      { say: "When do they let the dough rest?", holdMs: 6000 },
      { open: "yt-tedx-free-software" },
      { seek: 794000, play: true, untilMs: 801000 },
      { say: "Go back to the part about schools teaching software", holdMs: 7000 },
    ],
  },
  {
    id: "s4-real-footage",
    title: "Real footage: Tears of Steel (CC BY 3.0, Blender Foundation)",
    steps: [
      { say: "Play Tears of Steel", holdMs: 4000 },
      { seek: 548000, play: true, untilMs: 560000 }, // the viewer has watched up to 9:20
      { say: "Rewind to when they say there are two minutes left", holdMs: 8000 },
      { say: "What's happening?", holdMs: 9000 },
    ],
  },
];

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Emulators: record on the host (`adb emu screenrecord`, fixed 30 fps, no in-guest encoder load).
 * Real devices: in-device `screenrecord` (max 180 s).
 */
const EMULATOR = execFileSync("adb", ["get-serialno"]).toString().trim().startsWith("emulator-");

function startRecording(remote: string, local: string) {
  if (EMULATOR) {
    execFileSync("adb", ["emu", "screenrecord", "start", "--fps", "25", "--bit-rate", "16000000", "--time-limit", "180", resolvePath(local.replace(/\.mp4$/, ".webm"))]);
    return null;
  }
  return spawn("adb", ["shell", "screenrecord", "--time-limit", "180", "--bit-rate", "8000000", remote], { stdio: "ignore" });
}

async function stopRecording(proc: ReturnType<typeof spawn> | null, remote: string, local: string) {
  if (EMULATOR) {
    execFileSync("adb", ["emu", "screenrecord", "stop"]);
    await sleep(2500); // host encoder finalises the webm
    const webm = resolvePath(local.replace(/\.mp4$/, ".webm"));
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", webm, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-r", "25", resolvePath(local)]);
    return;
  }
  execFileSync("adb", ["shell", "pkill", "-INT", "screenrecord"]);
  await new Promise((r) => proc!.on("close", r));
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
  const proc = startRecording(remote, join(outDir, `${scene.id}.mp4`));
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
