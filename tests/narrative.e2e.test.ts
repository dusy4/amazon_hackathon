/**
 * End-to-end on the narrative title ("The Keeper's Key", v2 Dataset B): title switching, entity-aware
 * scene seeks, on-screen identification, sign reading, dialogue, spoiler guard, catch-up and clip+share.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../services/agent/src/main.ts";
import { SimPlayer } from "./helpers/sim-player.ts";

const PORT = 8798;
let srv: Awaited<ReturnType<typeof startServer>>;
let player: SimPlayer;
let dataDir: string;

const say = (text: string) => srv.orchestrator.handle(text, { inputSource: "test" });
const tools = (t: Awaited<ReturnType<typeof say>>) => t.trace.filter((s) => s.kind === "tool_call").map((s) => s.label);
const scene = (n: number) => srv.app.store.get("keepers-key")!.events.find((e) => e.id === `sc-${n}`)!;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "sp-story-"));
  cpSync("data/index", join(dataDir, "index"), { recursive: true });
  // Only the synthetic titles are exercised here; skip copying the large real-footage files.
  for (const id of ["harbor-v-northgate", "keepers-key"]) cpSync(`data/content/${id}`, join(dataDir, "content", id), { recursive: true });
  srv = await startServer({ port: PORT, dataDir, host: "127.0.0.1" });
  player = new SimPlayer();
  await player.connect(`ws://127.0.0.1:${PORT}/ws`);
});

afterAll(async () => {
  player?.close();
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("narrative title", () => {
  it("opens the film by name over MCP content.open", async () => {
    const t = await say("Watch The Keeper's Key");
    expect(tools(t)).toEqual(["content.open"]);
    expect(player.state.contentId).toBe("keepers-key");
    expect(t.speech).toBe("Opening The Keeper's Key.");
  });

  it("identifies who is speaking on screen", async () => {
    await player.playTo(scene(4).startMs + 4000); // "The map": Theo opens the scene
    const t = await say("Who is this?");
    expect(tools(t)).toEqual(["player.pause", "lens.identify"]); // freeze the frame asked about, then identify
    expect(t.speech).toMatch(/^That's Theo Quinn, the fisherman\./);
  });

  it("entity-aware scene seek: the previous scene with Theo", async () => {
    const t = await say("Go back to the previous scene with Theo");
    expect(t.speech).toBe("Scene 3 — Argument at Pier 4.");
    expect(player.state.positionMs).toBe(scene(3).startMs);
  });

  it("reads the sign on screen", async () => {
    const t = await say("Read that");
    expect(tools(t)).toEqual(["player.pause", "lens.read_text"]); // freeze the frame, then read it
    expect(t.speech).toBe("It says: PIER 4");
  });

  it("descriptive seek lands on the story beat, not the whole scene", async () => {
    const t = await say("Go to the scene where Mara finds the letter");
    expect(t.speech).toBe("Mara finds a letter in the empty key drawer.");
  });

  it("dialogue: what did she just say", async () => {
    await player.playTo(scene(2).startMs + 12000);
    const t = await say("What did she just say?");
    expect(t.speech).toMatch(/^Mara Quinn said: /);
  });

  it("spoiler guard: will not jump to a scene the viewer has not reached", async () => {
    const t = await say("Go to the scene where Mara finds the brass key");
    expect(t.speech).toMatch(/won't spoil it/);
  });

  it("clip a described scene and send it to the phone", async () => {
    await player.playTo(scene(4).endMs + 1000);
    const t = await say("Clip the scene where Theo shows the map and send it to my phone");
    expect(tools(t)).toEqual(["moments.search", "clip.create", "share.send"]);
    expect(t.speech).toMatch(/^Clipped Theo shows Mara their father's old map/);
  });

  it("catch me up summarises story beats, bounded by the playhead", async () => {
    const t = await say("I looked away for a minute, catch me up");
    expect(t.speech).toMatch(/Theo shows Mara their father's old map/);
    expect(t.speech).not.toMatch(/brass key in a tin box/);
  });

  it("switching back to the match restores sports behaviour", async () => {
    const t = await say("Switch to Harbor City vs Northgate");
    expect(player.state.contentId).toBe("harbor-v-northgate");
    expect(t.speech).toBe("Opening Harbor City FC vs Northgate United.");
  });
});
