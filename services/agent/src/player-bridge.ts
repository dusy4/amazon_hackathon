/**
 * Player bridge: the deterministic path from MCP player.* tools to a real player.
 *
 * Players (the TV web player and the Fire OS Media3 app) connect over WebSocket, report
 * PlayerState and execute PlayerCommands; every command is acknowledged with the resulting state.
 */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { PlayerCommand, PlayerState, WireMessage } from "../../../packages/contracts/src/index.ts";

interface PlayerConn {
  ws: WebSocket;
  deviceId: string;
  kind: PlayerState["deviceKind"];
  state: PlayerState | null;
  connectedAt: number;
}

export class PlayerBridge {
  private players = new Map<string, PlayerConn>();
  private pending = new Map<string, { resolve: (s: PlayerState) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private activeId: string | null = null;
  onState: (s: PlayerState) => void = () => {};

  register(ws: WebSocket, deviceId: string, kind: PlayerState["deviceKind"]) {
    this.players.set(deviceId, { ws, deviceId, kind, state: null, connectedAt: Date.now() });
    this.activeId = deviceId;
    ws.on("close", () => {
      if (this.players.get(deviceId)?.ws === ws) this.players.delete(deviceId);
      if (this.activeId === deviceId) this.activeId = [...this.players.keys()].pop() ?? null;
    });
  }

  handle(deviceId: string, msg: WireMessage) {
    const p = this.players.get(deviceId);
    if (!p) return;
    if (msg.type === "state") {
      p.state = msg.state;
      this.onState(msg.state);
    } else if (msg.type === "ack") {
      const w = this.pending.get(msg.id);
      if (!w) return;
      clearTimeout(w.timer);
      this.pending.delete(msg.id);
      if (msg.state) {
        p.state = msg.state;
        this.onState(msg.state);
      }
      msg.ok && msg.state ? w.resolve(msg.state) : w.reject(new Error(msg.error ?? "player rejected command"));
    }
  }

  setActive(deviceId: string) {
    if (this.players.has(deviceId)) this.activeId = deviceId;
  }

  list() {
    return [...this.players.values()].map((p) => ({ deviceId: p.deviceId, kind: p.kind, active: p.deviceId === this.activeId }));
  }

  get active(): PlayerConn | undefined {
    return this.activeId ? this.players.get(this.activeId) : undefined;
  }

  state(): PlayerState | null {
    return this.active?.state ?? null;
  }

  /** Send a command to the active player and wait for its acknowledged state. */
  send(command: PlayerCommand, timeoutMs = 5000): Promise<PlayerState> {
    const p = this.active;
    if (!p) return Promise.reject(new Error("No player is connected. Open the TV app (/tv) or the Fire OS app first."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`player ${p.deviceId} did not acknowledge ${command.cmd} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      p.ws.send(JSON.stringify({ type: "command", id, command } satisfies WireMessage));
    });
  }

  /** Fire-and-forget to every player (overlays/cards). */
  broadcast(command: PlayerCommand) {
    for (const p of this.players.values()) p.ws.send(JSON.stringify({ type: "command", id: randomUUID(), command } satisfies WireMessage));
  }
}
