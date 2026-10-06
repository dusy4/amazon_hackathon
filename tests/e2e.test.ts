/**
 * End-to-end: real server (MCP over Streamable HTTP + WS bridge) + a headless player.
 * Each utterance goes utterance → envelope → rules → MCP tools/call → player command → ack.
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../services/agent/src/main.ts";
import { SimPlayer } from "./helpers/sim-player.ts";

const PORT = 8799;
let srv: Awaited<ReturnType<typeof startServer>>;
let player: SimPlayer;
let dataDir: string;

const say = (text: string) => srv.orchestrator.handle(text, { inputSource: "test" });
const lastSeek = () => [...player.commands].reverse().find((c) => c.cmd === "seek") as { positionMs: number } | undefined;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "sp-e2e-"));
  cpSync("data/index", join(dataDir, "index"), { recursive: true });
  cpSync("data/content", join(dataDir, "content"), { recursive: true });
  srv = await startServer({ port: PORT, dataDir, host: "127.0.0.1" });
  player = new SimPlayer();
  await player.connect(`ws://127.0.0.1:${PORT}/ws`);
  await player.playTo(125000); // watched up to 2:05 → goal 1 seen, goal 2 not yet
});

afterAll(async () => {
  player?.close();
  await srv?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("MCP surface", () => {
  it("exposes the tool contract over Streamable HTTP", async () => {
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["player.seek", "player.loop", "moments.search", "lens.identify", "clip.create", "share.send", "memory.search"]));
    const res = (await c.callTool({ name: "lens.read_text", arguments: { atMs: 125000 } })) as { content: { text: string }[] };
    expect(JSON.parse(res.content[0].text).text).toBe("HCFC 1 - 0 NGU");
    await c.close();
  });
});

describe("conversational playback", () => {
  it("north star: replay of the last goal → earlier → slower → repeat → clip → phone", async () => {
    const t = await say("Rewind to the replay of the last goal, start three seconds before it, play it slower, repeat it twice, clip it, and send it to my phone");
    expect(t.trace.filter((s) => s.kind === "tool_call").map((s) => s.label)).toEqual([
      "moments.search", "moments.search", "player.seek", "player.seek", "player.set_speed", "player.loop", "clip.create", "share.send",
    ]);
    expect(player.state).toMatchObject({ rate: 0.5, loop: { startMs: 97000, remaining: 2 } });
    const clip = t.cards.find((c) => c.type === "clip");
    expect(clip && clip.type === "clip" && clip.share?.deepLink).toContain("/phone#clip=");
    expect(existsSync(join(dataDir, "clips", `${(clip as { clip: { clipId: string } }).clip.clipId}.mp4`))).toBe(true);
  });

  it("follow-ups reuse the grounded moment without a new search", async () => {
    await say("go back to the replay of that goal");
    expect(lastSeek()?.positionMs).toBe(100000);
    const t = await say("three seconds earlier");
    expect(t.trace.some((s) => s.label === "moments.search")).toBe(false);
    expect(lastSeek()?.positionMs).toBe(97000);
    await say("normal speed");
    expect(player.state.rate).toBe(1);
  });

  it("entity-aware: who is number 7 → his shots → the second one", async () => {
    const who = await say("who is number 7?");
    expect(who.speech).toMatch(/Silva/);
    const list = await say("show me his shots");
    const card = list.cards.find((c) => c.type === "moments");
    // Spoiler-safe: only Silva's shot (0:24) and first goal before 2:05.
    expect(card && card.type === "moments" && card.items.map((i) => i.label)).toEqual(["Shot — Silva (#7) (wide)", "Goal 1 — Silva (#7), 1-0"]);
    await say("the second one");
    expect(lastSeek()?.positionMs).toBe(88000);
  });

  it("spoiler guard, then spoilers off", async () => {
    const t = await say("show me the second goal");
    expect(t.speech).toMatch(/won't spoil/);
    await say("spoilers off");
    await say("show me the second goal");
    expect(lastSeek()?.positionMs).toBe(141000);
    await say("spoilers on");
  });

  it("anchored relation and screen text", async () => {
    await say("spoilers off");
    await say("go to the save before the second goal");
    expect(lastSeek()?.positionMs).toBe(124600);
    await say("spoilers on");
    const score = await say("read the score");
    expect(score.speech).toMatch(/Harbor City FC 1, Northgate United 0/);
  });

  it("catch me up and Viewing Memory", async () => {
    await player.playTo(125000);
    const c = await say("I was away for 2 minutes, catch me up");
    expect(c.speech).toMatch(/Silva/);
    expect(c.speech).not.toMatch(/Okafor \(#9\) equalises/);
    const m = await say("who was the player I asked about?");
    expect(m.speech).toMatch(/Silva \(#7, Harbor City FC\)/);
  });
});
