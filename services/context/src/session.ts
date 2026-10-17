/**
 * Conversational playback session: the state that makes follow-ups ("the replay", "three seconds
 * earlier", "again", "the second one", "his shots") resolvable without restating the query.
 */
import type { ClipRecord, GroundedReference, Moment, SpoilerMode } from "../../../packages/contracts/src/index.ts";

export class PlaybackSession {
  readonly sessionId: string;
  readonly userId: string;
  activeRef: GroundedReference | null = null;
  refHistory: GroundedReference[] = [];
  activeEntityId: string | null = null;
  /** Last absolute seek target produced by the agent; relative ops chain from here. */
  lastSeekTargetMs: number | null = null;
  /** The last moment search and the starts already shown for it, so "no, not that one" can narrow it. */
  lastSearch: { args: Record<string, unknown>; shownMs: number[] } | null = null;
  utterances: string[] = [];
  clips: ClipRecord[] = [];
  /** Furthest point the viewer has reached — the spoiler boundary and the "live" edge. */
  watchedUpToMs = 0;
  spoilerMode: SpoilerMode = "strict";
  accessibility = { captions: false, describeVisuals: false };

  /** Title the session state above belongs to; boundaries of other titles are kept per title. */
  contentId: string | null = null;
  private boundaries = new Map<string, number>();

  constructor(sessionId: string, userId: string) {
    this.sessionId = sessionId;
    this.userId = userId;
  }

  /** Switching titles: references and the spoiler boundary are per title, so park them and restore. */
  setContent(contentId: string | null) {
    if (!contentId || contentId === this.contentId) return false;
    if (this.contentId) this.boundaries.set(this.contentId, this.watchedUpToMs);
    this.contentId = contentId;
    this.watchedUpToMs = this.boundaries.get(contentId) ?? 0;
    this.activeRef = null;
    this.refHistory = [];
    this.activeEntityId = null;
    this.lastSeekTargetMs = null;
    this.lastSearch = null;
    this.lastPlayingMs = null;
    return true;
  }

  /** Previous playing position of the current title; null until a second consecutive report arrives. */
  private lastPlayingMs: number | null = null;

  observePosition(positionMs: number, isPlaying: boolean) {
    // Only natural playback advances the boundary: two consecutive playing reports moving forward by
    // less than 5 s. A single stale report (e.g. the previous title's position while a new one loads)
    // or a seek can never move it; agent seeks backwards never shrink it.
    if (!isPlaying) {
      this.lastPlayingMs = null;
      return;
    }
    const last = this.lastPlayingMs;
    this.lastPlayingMs = positionMs;
    if (last !== null && positionMs > last && positionMs - last < 5000 && positionMs > this.watchedUpToMs) this.watchedUpToMs = positionMs;
  }

  /** Explicit jump forward by the user (e.g. scrubbing) also moves the boundary. */
  extendBoundary(ms: number) {
    this.watchedUpToMs = Math.max(this.watchedUpToMs, ms);
  }

  ground(ref: Omit<GroundedReference, "createdAt">) {
    const r = { ...ref, createdAt: Date.now() };
    if (this.activeRef) this.refHistory.push(this.activeRef);
    this.refHistory = this.refHistory.slice(-20);
    this.activeRef = r;
    return r;
  }

  get activeMoment(): Moment | null {
    const r = this.activeRef;
    if (!r) return null;
    if (r.kind === "moment") return r.moment ?? null;
    if (r.kind === "result_set" && r.results?.length) return r.results[r.resultIndex ?? 0];
    if (r.kind === "clip") return r.moment ?? null;
    return null;
  }

  /** Most recent result set (for "the second one", "next one"). */
  get lastResultSet(): GroundedReference | null {
    if (this.activeRef?.kind === "result_set") return this.activeRef;
    for (let i = this.refHistory.length - 1; i >= 0; i--) if (this.refHistory[i].kind === "result_set") return this.refHistory[i];
    return null;
  }
}

export class SessionRegistry {
  private sessions = new Map<string, PlaybackSession>();
  get(sessionId = "living-room", userId = "demo-user") {
    let s = this.sessions.get(sessionId);
    if (!s) this.sessions.set(sessionId, (s = new PlaybackSession(sessionId, userId)));
    return s;
  }
}
