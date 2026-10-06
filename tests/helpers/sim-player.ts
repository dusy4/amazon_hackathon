/**
 * Headless player that speaks the real player wire protocol over /ws — used by integration tests
 * and the MCP smoke script so the full stack (orchestrator → MCP → bridge → player) is exercised.
 */
import WebSocket from "ws";
import type { PlayerCommand, PlayerState, WireMessage } from "../../packages/contracts/src/index.ts";

export class SimPlayer {
  ws!: WebSocket;
  state: PlayerState = {
    deviceId: "sim-player",
    deviceKind: "web",
    contentId: null,
    positionMs: 0,
    durationMs: 246000,
    paused: true,
    rate: 1,
    loop: null,
    segment: null,
    updatedAt: Date.now(),
  };
  commands: PlayerCommand[] = [];

  async connect(url: string) {
    this.ws = new WebSocket(url);
    await new Promise((r) => this.ws.once("open", r));
    this.ws.on("message", (raw) => this.onMessage(JSON.parse(String(raw)) as WireMessage));
    this.send({ type: "hello", role: "player", deviceId: this.state.deviceId, deviceKind: "web" });
    await new Promise((r) => setTimeout(r, 100));
  }

  private send(m: WireMessage) {
    this.ws.send(JSON.stringify(m));
  }

  /** Simulate natural playback to a point (advances the spoiler boundary like real watching). */
  async playTo(ms: number) {
    for (let p = this.state.positionMs; p <= ms; p += 4000) {
      this.state = { ...this.state, positionMs: Math.min(p, ms), paused: false, updatedAt: Date.now() };
      this.send({ type: "state", state: this.state });
    }
    this.state = { ...this.state, positionMs: ms, paused: false };
    this.send({ type: "state", state: this.state });
    await new Promise((r) => setTimeout(r, 50));
  }

  private onMessage(m: WireMessage) {
    if (m.type !== "command") return;
    const c = m.command;
    this.commands.push(c);
    const s = { ...this.state };
    switch (c.cmd) {
      case "load":
        s.contentId = c.contentId;
        break;
      case "seek":
        s.positionMs = c.positionMs;
        s.loop = null;
        s.segment = null;
        break;
      case "play":
        s.paused = false;
        break;
      case "pause":
        s.paused = true;
        break;
      case "set_rate":
        s.rate = c.rate;
        break;
      case "play_segment":
        s.positionMs = c.startMs;
        s.segment = { startMs: c.startMs, endMs: c.endMs };
        s.paused = false;
        break;
      case "loop":
        s.positionMs = c.startMs;
        s.loop = { startMs: c.startMs, endMs: c.endMs, remaining: c.count };
        s.paused = false;
        break;
      case "clear_loop":
        s.loop = null;
        s.segment = null;
        break;
    }
    s.updatedAt = Date.now();
    this.state = s;
    this.send({ type: "ack", id: m.id, ok: true, state: s });
  }

  close() {
    this.ws.close();
  }
}
