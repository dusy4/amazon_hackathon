import { agentCoreMemory } from "../../context/src/agentcore-memory.ts";
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
      if (s.contentId) this.currentContentId = s.contentId;
      this.sessions.get().setContent(s.contentId);
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

  /** Last title opened on any player; newly connecting players load it. */
  currentContentId: string | null = null;

  /** Content currently on the active player (falls back to the last opened, then the first indexed title). */
  currentIndex() {
    return this.store.get(this.bridge.state()?.contentId) ?? this.store.get(this.currentContentId) ?? this.store.list()[0];
  }

  /** Find a title from a spoken description: kind words ("the match", "the movie") or title keywords. */
  findContent(query: string) {
    const q = query.toLowerCase();
    const all = this.store.list();
    const kind = /\b(match|game)\b/.test(q) ? "sports_match" : /\b(movie|film|story)\b/.test(q) ? "narrative" : null;
    const words = (t: string) => t.toLowerCase().replace(/'s\b/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && w !== "the");
    const scored = all
      .map((c) => ({ c, score: words(c.title).filter((w) => q.includes(w)).length + (kind && c.kind === kind ? 0.5 : 0) }))
      .sort((a, b) => b.score - a.score);
    return scored[0]?.score > 0 ? scored[0].c : undefined;
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
    void agentCoreMemory?.append(ev); // AgentCore Memory mirror: never blocks the request
    return ev;
  }
}
