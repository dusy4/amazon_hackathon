import { randomUUID } from "node:crypto";
import type { ActionEvent, ClipRecord, ShareRecord, WireMessage } from "../../../packages/contracts/src/index.ts";
import { ContentStore } from "../../context/src/content-store.ts";
import { type ViewingMemory, createViewingMemory } from "../../context/src/memory.ts";
import { SessionRegistry } from "../../context/src/session.ts";
import { PlayerBridge } from "./player-bridge.ts";
import { MomentRetriever } from "./retrieval.ts";

export interface AppConfig {
  dataDir: string;
  port: number;
  publicBaseUrl: string;
}

/** Shared runtime state for the MCP tools, the orchestrator and the HTTP/WS server. */
export class AppContext {
  readonly store: ContentStore;
  readonly memory: ViewingMemory;
  readonly sessions = new SessionRegistry();
  readonly bridge = new PlayerBridge();
  readonly retriever = new MomentRetriever();
  readonly clips = new Map<string, ClipRecord>();
  readonly shares: ShareRecord[] = [];
  private listeners = new Set<(m: WireMessage) => void>();

  constructor(readonly config: AppConfig) {
    this.store = new ContentStore(config.dataDir);
    this.memory = createViewingMemory(config.dataDir);
    this.bridge.onState = (s) => {
      this.sessions.get().observePosition(s.positionMs, !s.paused);
      this.emit({ type: "state", state: s });
    };
  }

  onEmit(fn: (m: WireMessage) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(m: WireMessage) {
    for (const l of this.listeners) l(m);
  }

  /** Content currently on the active player (falls back to the only indexed title). */
  currentIndex() {
    return this.store.get(this.bridge.state()?.contentId) ?? this.store.list()[0];
  }

  async record(e: Omit<ActionEvent, "id" | "wallClock" | "privacy" | "userId" | "sessionId" | "sourceDevice"> & { sessionId?: string }) {
    const session = this.sessions.get(e.sessionId);
    const ev: ActionEvent = {
      id: randomUUID(),
      userId: session.userId,
      sessionId: session.sessionId,
      wallClock: new Date().toISOString(),
      privacy: "user_activity",
      sourceDevice: this.bridge.active?.deviceId ?? "unknown",
      ...e,
    };
    await this.memory.append(ev);
    return ev;
  }
}
