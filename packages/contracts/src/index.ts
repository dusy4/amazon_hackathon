/**
 * Semantic Playback shared contracts.
 *
 * These types are the single shape shared by ingestion (services/media), the Context Service
 * (services/context), the agent + MCP server (services/agent) and the players (apps/fire-tv).
 * MCP tool input schemas live next to the tools; the player wire protocol lives here because
 * both the web player and the Fire OS player implement it.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Provenance — every derived fact carries where it came from (v2: "Provenance metadata")
// ---------------------------------------------------------------------------------------------
export type EpistemicType = "observed" | "provider_metadata" | "inferred" | "remembered";

export interface Provenance {
  /** e.g. "provider-feed", "commentary-script", "amazon-transcribe", "amazon-rekognition", "local-hash-v1" */
  source: string;
  confidence: number;
  epistemicType: EpistemicType;
  privacy: "content_metadata" | "user_activity";
  spoilerScope?: "safe_before_playhead" | "full";
}

// ---------------------------------------------------------------------------------------------
// Content + timeline
// ---------------------------------------------------------------------------------------------
export interface Entity {
  /** "player:HCFC:7", "team:HCFC" */
  id: string;
  type: "player" | "team" | "person" | "character" | "object";
  name: string;
  aliases: string[];
  team?: string;
  number?: number;
  role?: string;
  /** Narrative titles: one-line who/what description from the provider. */
  description?: string;
}

export interface ProviderEvent {
  id: string;
  type: string;
  startMs: number;
  endMs: number;
  description: string;
  players: { team: string; number: number; name: string }[];
  ofEventId?: string;
  outcome?: string;
  score?: { home: number; away: number };
  goalNumber?: number;
  scorer?: { team: string; number: number; name: string };
  assist?: { team: string; number: number; name: string };
  method?: string;
  rate?: number;
  /** Narrative titles: characters/objects involved (sports events use `players`). */
  entityIds?: string[];
  sceneId?: string;
  title?: string;
}

export interface TranscriptLine {
  id: string;
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
}

export type SegmentKind = "event" | "replay" | "window";

export interface Segment {
  id: string;
  contentId: string;
  kind: SegmentKind;
  startMs: number;
  endMs: number;
  eventId?: string;
  eventType?: string;
  /** For replay segments: the event this replay shows. */
  ofEventId?: string;
  /** Human-readable label, e.g. "Goal 1 — Silva (#7)". */
  label: string;
  /** Text used for lexical + semantic retrieval: description + overlapping transcript + entities. */
  text: string;
  transcript: string;
  entityIds: string[];
  /** Scoreboard text visible during the segment (OCR or provider scoreboard). */
  screenText: string[];
  embedding?: number[];
  provenance: Provenance[];
}

export interface ContentIndex {
  contentId: string;
  title: string;
  kind: string;
  durationMs: number;
  /** Path relative to the content directory, served at /media/<contentId>/<media>. */
  media: string;
  builtAt: string;
  embeddingModel: string;
  embeddingDim: number;
  sources: Record<string, string>;
  entities: Entity[];
  events: ProviderEvent[];
  transcript: TranscriptLine[];
  segments: Segment[];
  scoreboard: { startMs: number; endMs: number; text: string; home: number; away: number }[];
  possession: { startMs: number; endMs: number; team: string; number: number; name: string }[];
  touches: { ms: number; team: string; number: number; name: string }[];
  teams: { id: string; name: string; short: string; side: "home" | "away" }[];
  /** Narrative titles: on-screen text (signs, letters, maps) with visibility windows. */
  signs?: { startMs: number; endMs: number; text: string; kind?: string }[];
  /** Narrative titles: who is on screen when (the narrative analogue of possession). */
  presence?: { startMs: number; endMs: number; entityId: string; name: string }[];
}

export const isNarrative = (index: Pick<ContentIndex, "kind"> | undefined | null) => index?.kind === "narrative";

// ---------------------------------------------------------------------------------------------
// Player state + wire protocol (web player and Fire OS player both implement this)
// ---------------------------------------------------------------------------------------------
export interface PlayerState {
  deviceId: string;
  deviceKind: "web" | "fireos";
  contentId: string | null;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  rate: number;
  loop: { startMs: number; endMs: number; remaining: number } | null;
  segment: { startMs: number; endMs: number } | null;
  updatedAt: number;
}

export const PlayerCommandSchema = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("load"), contentId: z.string(), url: z.string(), positionMs: z.number().optional() }),
  z.object({ cmd: z.literal("seek"), positionMs: z.number() }),
  z.object({ cmd: z.literal("play") }),
  z.object({ cmd: z.literal("pause") }),
  z.object({ cmd: z.literal("set_rate"), rate: z.number() }),
  z.object({ cmd: z.literal("play_segment"), startMs: z.number(), endMs: z.number() }),
  z.object({ cmd: z.literal("loop"), startMs: z.number(), endMs: z.number(), count: z.number() }),
  z.object({ cmd: z.literal("clear_loop") }),
  z.object({ cmd: z.literal("overlay"), overlay: z.any() }),
]);
export type PlayerCommand = z.infer<typeof PlayerCommandSchema>;

/** Messages over the /ws socket. */
export type WireMessage =
  | { type: "hello"; role: "player" | "ui" | "companion"; deviceId: string; deviceKind?: PlayerState["deviceKind"]; contentId?: string }
  | { type: "command"; id: string; command: PlayerCommand }
  | { type: "ack"; id: string; ok: boolean; error?: string; state?: PlayerState }
  | { type: "state"; state: PlayerState }
  | { type: "trace"; trace: TraceStep; turnId: string }
  | { type: "turn"; turn: TurnResult }
  | { type: "share"; share: ShareRecord }
  | { type: "utterance"; text: string; source: string };

// ---------------------------------------------------------------------------------------------
// Grounded references — "that goal", "the replay", "his shots", "the second one"
// ---------------------------------------------------------------------------------------------
export interface Moment {
  segmentId: string;
  kind: SegmentKind;
  eventId?: string;
  eventType?: string;
  ofEventId?: string;
  startMs: number;
  endMs: number;
  label: string;
  score: number;
  scoreBreakdown: Record<string, number>;
  entityIds: string[];
}

export interface GroundedReference {
  kind: "moment" | "result_set" | "entity" | "clip";
  label: string;
  moment?: Moment;
  results?: Moment[];
  resultIndex?: number;
  entityId?: string;
  clipId?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------------------------
// Context Envelope (v2: Relevant Core / Ambient Context / Deep Context)
// ---------------------------------------------------------------------------------------------
export type SpoilerMode = "strict" | "full";

export interface ContextEnvelope {
  request: { utterance: string; receivedAt: string; device: string; sessionId: string; inputSource: string };
  relevantCore: {
    contentId: string | null;
    title: string | null;
    playback: Pick<PlayerState, "positionMs" | "durationMs" | "paused" | "rate" | "loop" | "deviceKind"> | null;
    activeReference: GroundedReference | null;
    activeEntity: { id: string; name: string } | null;
    currentEntities: { id: string; name: string; why: string; appearance?: string }[];
    transcriptWindow: { startMs: number; text: string }[];
    screenText: string | null;
    spoilerBoundaryMs: number;
    spoilerMode: SpoilerMode;
  };
  ambient: {
    recentActions: { type: string; summary: string; at: string }[];
    previousUtterances: string[];
    recentClips: { clipId: string; label: string }[];
    accessibility: { captions: boolean; describeVisuals: boolean };
    devices: { deviceId: string; kind: string }[];
  };
  deep: {
    timelineIndexRef: string | null;
    transcriptRef: string | null;
    viewingActivityRef: string;
    mediaRef: string | null;
    embeddingModel: string | null;
  };
}

// ---------------------------------------------------------------------------------------------
// Viewing Memory (canonical event log; LLM-derived memory never replaces it)
// ---------------------------------------------------------------------------------------------
export type ActionEventType =
  | "semantic_seek"
  | "relative_seek"
  | "rewatch_moment"
  | "loop_moment"
  | "speed_change"
  | "who_is_this"
  | "ocr_read"
  | "transcript_request"
  | "scene_explained"
  | "accessibility_description"
  | "catch_up_generated"
  | "moments_listed"
  | "clip_created"
  | "clip_shared"
  | "memory_query"
  | "content_opened";

export interface ActionEvent {
  id: string;
  userId: string;
  sessionId: string;
  type: ActionEventType;
  contentId: string | null;
  contentTimeMs: number | null;
  wallClock: string;
  summary: string;
  entityIds: string[];
  payload: Record<string, unknown>;
  sourceDevice: string;
  privacy: "user_activity";
}

// ---------------------------------------------------------------------------------------------
// Clips + sharing
// ---------------------------------------------------------------------------------------------
export interface ClipRecord {
  clipId: string;
  contentId: string;
  startMs: number;
  endMs: number;
  label: string;
  url: string;
  thumbnailUrl: string;
  watchFullUrl: string;
  attribution: string;
  createdAt: string;
  renderer: string;
  renderMs: number;
}

export interface ShareRecord {
  shareId: string;
  clipId: string;
  destination: string;
  deepLink: string;
  qrSvg: string;
  createdAt: string;
  clip: ClipRecord;
}

// ---------------------------------------------------------------------------------------------
// Agent turn + trace (the demo's "real pipeline" layer)
// ---------------------------------------------------------------------------------------------
export type TraceKind = "input" | "intent" | "context" | "tool_call" | "tool_result" | "action" | "memory" | "answer" | "error";

export interface TraceStep {
  kind: TraceKind;
  label: string;
  /** Component that actually did the work, e.g. "rules-parser", "bedrock:<model>", "mcp:moments.search" */
  component: string;
  data?: unknown;
  ms: number;
}

export interface TurnResult {
  turnId: string;
  utterance: string;
  speech: string;
  cards: AnswerCard[];
  trace: TraceStep[];
  interpreter: string;
  durationMs: number;
}

export type AnswerCard =
  | { type: "moment"; title: string; subtitle?: string; startMs: number; endMs: number }
  | { type: "moments"; title: string; items: { label: string; startMs: number; endMs: number }[]; selected?: number }
  | { type: "entity"; title: string; subtitle?: string; facts: string[] }
  | { type: "text"; title: string; body: string }
  | { type: "clip"; title: string; clip: ClipRecord; share?: ShareRecord }
  | { type: "memory"; title: string; items: { summary: string; at: string; contentTimeMs: number | null }[] };

export const entityIdForPlayer = (team: string, number: number) => `player:${team}:${number}`;
export const entityIdForTeam = (team: string) => `team:${team}`;

export function formatMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
