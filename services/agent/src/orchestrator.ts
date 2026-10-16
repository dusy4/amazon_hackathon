/**
 * Orchestrator: utterance → Context Envelope → intent(s) → MCP tool calls → player action → memory.
 *
 * Every tool call goes over real MCP (Streamable HTTP) to the self-hosted server, and every step is
 * emitted as a TraceStep — the trace IS the demo's pipeline layer, so it can never show a fake call.
 */
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type AnswerCard,
  type ClipRecord,
  type ContextEnvelope,
  type Moment,
  type PlayerState,
  type TraceStep,
  type TurnResult,
  entityIdForPlayer,
  formatMs,
  isNarrative,
} from "../../../packages/contracts/src/index.ts";
import { buildEnvelope } from "../../context/src/envelope.ts";
import type { PlaybackSession } from "../../context/src/session.ts";
import type { AppContext } from "./app-context.ts";
import { defaultChatModel } from "./llm.ts";
import { LlmAgent, LlmDeadlineError } from "./llm-agent.ts";
import { resolveEntities } from "./entities.ts";
import { type Intent, type MomentSpec, parseMomentSpec, parseUtterance, splitClauses } from "./intent.ts";

interface SearchResult {
  moments: Moment[];
  hiddenBySpoilerBoundary: number;
  bestMatchHidden?: boolean;
}

/**
 * Intents the rules parser may execute on its own: unambiguous transport controls whose arguments are
 * fully determined by the words ("pause", "half speed", "three seconds earlier", "repeat it twice").
 * Anything that needs understanding — finding a moment, identifying someone, sharing, switching titles —
 * goes to the LLM agent. With no LLM configured (or if it fails) the rules handle everything they can.
 */
const FAST_PATH = new Set<Intent["type"]>(["pause", "play", "set_speed", "relative_seek", "loop", "again", "clear_loop", "spoilers", "select_result", "return_live"]);

/**
 * On titles with an authoritative provider event feed (the sports match), the rules interpreter also owns
 * structured requests — "the replay of the last goal", "who is number 7", "every yellow card" — because
 * the feed answers them exactly in milliseconds (golden set: 11/12 match cases). Free-form or descriptive
 * requests ("where Silva hit the woodwork" is fine, "the bit where they argue" is not) still go to the LLM.
 */
const STRUCTURED_RULES = new Set<Intent["type"]>([
  ...FAST_PATH, "seek_moment", "list_moments", "identify", "read_text", "what_said", "describe", "catch_up", "clip", "share", "memory_query",
]);
const specIsStructured = (i: Intent) => !("spec" in i) || !i.spec || i.spec.eventTypes.length > 0 || i.spec.replay;

/**
 * Requests that need no moment grounding map 1:1 onto a deterministic tool on ANY title — Viewing Lens
 * (live Rekognition), screen text, transcript, catch-up, clip/share of the active moment, memory. Routing
 * them through the LLM only adds latency.
 */
const TOOL_DIRECT = new Set<Intent["type"]>(["identify", "read_text", "what_said", "describe", "catch_up", "share", "memory_query"]);
const isToolDirect = (i: Intent) => TOOL_DIRECT.has(i.type) || (i.type === "clip" && !i.spec);

/** Upper bound on an LLM turn before the rules interpreter takes over (free models can take a minute). */
const LLM_DEADLINE_MS = Number(process.env.SP_LLM_DEADLINE_MS ?? 25000);

class SpoilerGuard extends Error {}

export class Orchestrator {
  private client: Client | null = null;
  private llm: LlmAgent | null = (() => {
    const m = defaultChatModel();
    return m ? new LlmAgent(m) : null;
  })();

  constructor(private app: AppContext, private mcpUrl: string) {}

  get interpreterName() {
    return this.llm ? `${this.llm.label} (rules fast path)` : "rules";
  }

  private async mcp(): Promise<Client> {
    if (this.client) return this.client;
    const c = new Client({ name: "semantic-playback-orchestrator", version: "0.1.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(this.mcpUrl)));
    this.client = c;
    return c;
  }

  async handle(utterance: string, opts: { inputSource?: string; device?: string; sessionId?: string } = {}): Promise<TurnResult> {
    const turnId = randomUUID().slice(0, 8);
    const t0 = Date.now();
    const trace: TraceStep[] = [];
    const step = (s: Omit<TraceStep, "ms">) => {
      const full = { ...s, ms: Date.now() - t0 };
      trace.push(full);
      this.app.emit({ type: "trace", trace: full, turnId });
    };
    const session = this.app.sessions.get(opts.sessionId);
    const index = this.app.currentIndex();
    const speech: string[] = [];
    const cards: AnswerCard[] = [];
    let interpreter = "rules";

    step({ kind: "input", label: `“${utterance}”`, component: opts.inputSource ?? "text" });
    const envelope = await buildEnvelope({
      utterance,
      inputSource: opts.inputSource ?? "text",
      device: opts.device ?? "tv",
      session,
      player: this.app.bridge.state(),
      index,
      memory: this.app.memory,
      devices: this.app.bridge.list().map((d) => ({ deviceId: d.deviceId, kind: d.kind })),
    });
    step({ kind: "context", label: "Context Envelope", component: "context-service", data: envelope });
    session.utterances.push(utterance);

    const intents = parseUtterance(utterance, this.app.store.list().map((c) => c.title));
    const known = intents.filter((i) => i.type !== "unknown");
    step({ kind: "intent", label: intents.map((i) => i.type).join(" → "), component: "rules-parser", data: intents });

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      step({ kind: "tool_call", label: name, component: `mcp:${name}`, data: args });
      const res = (await (await this.mcp()).callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
      const data = JSON.parse(res.content[0]?.text ?? "{}");
      step({ kind: res.isError ? "error" : "tool_result", label: name, component: `mcp:${name}`, data: summarize(name, data) });
      if (res.isError) throw new Error(data.error ?? `${name} failed`);
      return data;
    };

    const ctx: SkillCtx = { app: this.app, session, envelope, call, speech, cards, step };

    // Fast path only when every clause is a transport control AND no clause refers to a moment
    // ("show me the equaliser again" needs understanding, "again" alone does not).
    const transportOnly = intents.length > 0 && intents.every((i) => FAST_PATH.has(i.type)) && splitClauses(utterance).every((c) => !parseMomentSpec(c));
    const structured =
      index?.kind === "sports_match" && intents.length > 0 && intents.every((i) => STRUCTURED_RULES.has(i.type) && specIsStructured(i));
    const direct = intents.length > 0 && intents.every((i) => FAST_PATH.has(i.type) || isToolDirect(i)) && !transportOnly;
    const fastPath = transportOnly || structured || direct;
    if (direct && !structured) step({ kind: "intent", label: "direct tool request (no grounding needed) → rules", component: "router" });
    if (structured && !transportOnly) step({ kind: "intent", label: "structured request on a title with a provider event feed → rules", component: "router" });
    let useRules = !this.llm || fastPath;
    if (this.llm && !fastPath) {
      interpreter = this.llm.label;
      try {
        const catalog = this.app.store.list().map((c) => ({ contentId: c.contentId, title: c.title, kind: c.kind }));
        const observed = observeLlmCalls(ctx);
        const deadline = Date.now() + LLM_DEADLINE_MS;
        const run = this.llm.run(utterance, envelope, catalog, observed, step, async () => (await (await this.mcp()).listTools()).tools, deadline);
        run.catch(() => {}); // a run abandoned at the deadline stops itself at its next checkpoint
        const r = await Promise.race([
          run,
          new Promise<never>((_, reject) => setTimeout(() => reject(new LlmDeadlineError(`LLM exceeded its ${LLM_DEADLINE_MS / 1000} s budget`)), LLM_DEADLINE_MS)),
        ]);
        // Spoken on a TV and by Polly: no markdown.
        speech.push(r.replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, "").trim());
      } catch (e) {
        // The model is unavailable (quota, network): degrade to the rules interpreter, visibly.
        step({ kind: "error", label: `LLM unavailable: ${(e as Error).message.slice(0, 120)} — falling back to rules`, component: this.llm.label });
        interpreter = "rules (LLM fallback)";
        useRules = true;
      }
    }
    try {
      if (!useRules) {
        /* handled by the LLM agent */
      } else if (!known.length) {
        speech.push("Sorry, I didn't catch a playback request there. Try “go back to the replay of the last goal”.");
      } else {
        for (const intent of intents) {
          if (intent.type === "unknown") {
            step({ kind: "intent", label: `skipped: “${intent.text}”`, component: "rules-parser" });
            continue;
          }
          await runIntent(intent, ctx);
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      step({ kind: "error", label: msg, component: "orchestrator" });
      speech.push(e instanceof SpoilerGuard ? msg : `I couldn't do that: ${msg}`);
    }

    const result: TurnResult = { turnId, utterance, speech: speech.join(" "), cards, trace, interpreter, durationMs: Date.now() - t0 };
    step({ kind: "answer", label: result.speech, component: "orchestrator" });
    this.app.emit({ type: "turn", turn: result });
    this.app.bridge.broadcast({ cmd: "overlay", overlay: { speech: result.speech, cards: cards.map(stripHeavy), steps: trace.filter((s) => s.kind === "tool_call").map((s) => s.label) } });
    return result;
  }
}

/**
 * Wraps MCP calls made by the LLM so the session stays grounded exactly as on the rules path:
 * a seek to a searched moment grounds it ("that goal", "clip it"), identifications set the active
 * entity ("his shots"), and clip/share results become cards on screen.
 */
function observeLlmCalls(c: SkillCtx) {
  let lastResults: Moment[] = [];
  return async (name: string, args: Record<string, unknown> = {}) => {
    const data = await c.call(name, args);
    if (name === "moments.search") {
      lastResults = data.moments ?? [];
      if (lastResults.length > 1) c.session.ground({ kind: "result_set", label: String(args.query ?? ""), results: lastResults, resultIndex: 0 });
    } else if (name === "player.seek") {
      const m = lastResults.find((x) => Math.abs(x.startMs - Number(args.positionMs)) < 1500);
      if (m) {
        await groundMoment(c, m, "semantic_seek");
        c.cards.push({ type: "moment", title: m.label, subtitle: `${formatMs(m.startMs)}–${formatMs(m.endMs)} · score ${m.score}`, startMs: m.startMs, endMs: m.endMs });
      }
    } else if (name === "lens.identify" && data.entity?.id) {
      c.session.activeEntityId = data.entity.id;
      c.cards.push({ type: "entity", title: data.entity.name, subtitle: data.entity.role, facts: [...(data.facts ?? []), `source: ${data.provenance?.source}`] });
    } else if (name === "clip.create" && data.clip) {
      c.session.ground({ kind: "clip", label: data.clip.label, clipId: data.clip.clipId, moment: c.session.activeMoment ?? undefined });
      c.cards.push({ type: "clip", title: data.clip.label, clip: data.clip });
    } else if (name === "share.send" && data.share) {
      const full = c.app.shares.find((s) => s.shareId === data.share.shareId);
      const card = c.cards.find((x): x is Extract<AnswerCard, { type: "clip" }> => x.type === "clip" && x.clip.clipId === data.share.clipId);
      if (card && full) card.share = full;
    }
    return data;
  };
}

// ---------------------------------------------------------------------------------------------
// Skills — deterministic execution of each intent
// ---------------------------------------------------------------------------------------------
interface SkillCtx {
  app: AppContext;
  session: PlaybackSession;
  envelope: ContextEnvelope;
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  speech: string[];
  cards: AnswerCard[];
  step: (s: Omit<TraceStep, "ms">) => void;
}

/** People in a moment: players (sports) or characters (narrative). */
const isPersonId = (id: string) => id.startsWith("player:") || id.startsWith("character:");

const pos = (c: SkillCtx) => (c.app.bridge.state()?.positionMs ?? c.envelope.relevantCore.playback?.positionMs ?? 0);

function eventStart(c: SkillCtx, m: Moment) {
  const ev = m.eventId ? c.app.currentIndex()?.events.find((e) => e.id === m.eventId) : undefined;
  return ev?.startMs ?? m.startMs;
}

function primaryEntity(c: SkillCtx, m: Moment): string | null {
  const ev = m.eventId ? c.app.currentIndex()?.events.find((e) => e.id === (m.ofEventId ?? m.eventId)) : undefined;
  const target = m.ofEventId ? c.app.currentIndex()?.events.find((e) => e.id === m.ofEventId) : ev;
  if (target?.scorer) return entityIdForPlayer(target.scorer.team, target.scorer.number);
  const p = target?.players[0];
  return p ? entityIdForPlayer(p.team, p.number) : (m.entityIds.find(isPersonId) ?? null);
}

function entityIdsFor(c: SkillCtx, spec: MomentSpec): string[] | undefined {
  const index = c.app.currentIndex();
  if (!index) return undefined;
  const ids = resolveEntities(index, spec.mentionText, pos(c))
    .filter((r) => r.entity.type === "player" || !spec.eventTypes.length || true)
    .map((r) => r.entity.id);
  if (!ids.length && spec.pronoun && c.session.activeEntityId) ids.push(c.session.activeEntityId);
  return ids.length ? ids : undefined;
}

async function search(c: SkillCtx, args: Record<string, unknown>): Promise<SearchResult> {
  const r: SearchResult = await c.call("moments.search", args);
  // The best match for a described moment hasn't been watched yet: say so rather than settle for a weaker visible one.
  if (r.bestMatchHidden) throw new SpoilerGuard("I won't spoil it — that happens after the point you've watched up to. Say “spoilers off” if you want it anyway.");
  return r;
}

function noResult(c: SkillCtx, r: SearchResult, what: string): never {
  if (r.hiddenBySpoilerBoundary > 0)
    throw new SpoilerGuard(`I won't spoil it — ${what} happens after the point you've watched up to. Say “spoilers off” if you want it anyway.`);
  throw new Error(`I couldn't find ${what}.`);
}

/** Resolve a MomentSpec to a grounded moment (no player action). */
async function resolveMoment(c: SkillCtx, spec: MomentSpec): Promise<Moment> {
  const entityIds = entityIdsFor(c, spec);
  const active = c.session.activeMoment;
  const here = pos(c);

  // Anchored: "the save before the second goal"
  let anchorMs: number | undefined;
  if (spec.anchor) {
    const a = await resolveMoment(c, spec.anchor.spec);
    anchorMs = eventStart(c, a);
  }

  const resolveBase = async (types: string[]): Promise<Moment> => {
    // "the equaliser" / "levelled it": among goals, only those after which the score is level.
    // A descriptive name picks its own goal, so it must not resolve to the active reference.
    const levelling = types.includes("goal") && /\bequali[sz]\w*|\blevel(led|ler|s)?\b/.test(spec.query);
    // "that goal" / "the goal": prefer the grounded reference.
    if (spec.deictic && active && !spec.anchor && !spec.descriptive && !levelling) {
      const activeType = active.kind === "replay" ? c.app.currentIndex()?.events.find((e) => e.id === active.ofEventId)?.type : active.eventType;
      if (activeType && types.includes(activeType)) {
        c.step({ kind: "intent", label: `“that ${activeType.replace("_", " ")}” → active reference ${active.label}`, component: "context-service" });
        return active.kind === "replay" ? await baseOfReplay(c, active) : active;
      }
    }
    const args: Record<string, unknown> = { query: spec.query, eventTypes: types, entityIds };
    if (typeof spec.ordinal === "number") Object.assign(args, { ordinal: spec.ordinal });
    else if (spec.ordinal === "next") Object.assign(args, { relation: "after", anchorMs: active ? eventStart(c, active) : here, order: "first" });
    else if (spec.ordinal === "previous" && active) Object.assign(args, { relation: "before", anchorMs: eventStart(c, active) - 1, order: "nearest" });
    else if (spec.ordinal === "previous" && types.includes("scene")) {
      const cur = c.app.currentIndex()?.events.find((e) => e.type === "scene" && e.startMs <= here && here < e.endMs);
      Object.assign(args, { relation: "before", anchorMs: (cur?.startMs ?? here) - 1, order: "nearest" });
    }
    else if (anchorMs !== undefined) Object.assign(args, { relation: spec.anchor!.relation, anchorMs, order: spec.anchor!.relation === "before" ? "nearest" : "first" });
    else if (spec.descriptive) Object.assign(args, { order: "relevance" });
    else Object.assign(args, { relation: "before", order: "nearest" });
    const r = await search(c, { ...args, limit: levelling ? 10 : 3 });
    if (levelling) {
      const events = c.app.currentIndex()?.events ?? [];
      const level = r.moments.filter((m) => {
        const ev = events.find((e) => e.id === m.eventId);
        return ev?.type !== "goal" || (ev.score !== undefined && ev.score.home === ev.score.away);
      });
      if (!level.length) {
        // The temporal filter hides future goals before spoiler counting, so check the feed directly.
        const boundary = c.envelope.relevantCore.spoilerBoundaryMs;
        const later = events.some((e) => e.type === "goal" && e.score && e.score.home === e.score.away && e.startMs > boundary);
        noResult(c, { ...r, hiddenBySpoilerBoundary: later && c.session.spoilerMode === "strict" ? 1 : r.hiddenBySpoilerBoundary }, "the equaliser");
      }
      r.moments = level;
    }
    if (!r.moments.length) noResult(c, r, `that ${types[0].replace("_", " ")}${entityIds?.length ? ` with ${entityNames(c, entityIds)}` : ""}`);
    return r.moments[0];
  };

  if (spec.replay) {
    let base: Moment | null = null;
    if (spec.eventTypes.length) base = await resolveBase(spec.eventTypes);
    else if (active?.kind === "replay") return active;
    else if (active && active.kind === "event") base = active;
    if (base) {
      const baseEventId = base.kind === "replay" ? base.ofEventId : base.eventId;
      const r = await search(c, { query: `replay of ${base.label}`, replayOfEventId: baseEventId, limit: 1 });
      if (r.moments.length) return r.moments[0];
      c.speech.push(`There's no replay of ${base.label}, so here's the moment itself.`);
      return base;
    }
    const r = await search(c, { query: spec.query, eventTypes: ["replay"], entityIds, relation: "before", order: "nearest", limit: 1 });
    if (!r.moments.length) noResult(c, r, "a replay");
    return r.moments[0];
  }
  if (spec.eventTypes.length) return resolveBase(spec.eventTypes);

  const r = await search(c, { query: spec.query, entityIds, includeWindows: true, order: "relevance", limit: 3 });
  if (!r.moments.length) noResult(c, r, "that moment");
  return r.moments[0];
}

function entityNames(c: SkillCtx, ids: string[]) {
  return ids.map((id) => c.app.currentIndex()?.entities.find((e) => e.id === id)?.name ?? id).join(" and ");
}

async function baseOfReplay(c: SkillCtx, replay: Moment): Promise<Moment> {
  const seg = c.app.currentIndex()?.segments.find((s) => s.eventId === replay.ofEventId);
  if (!seg) return replay;
  return { segmentId: seg.id, kind: seg.kind, eventId: seg.eventId, eventType: seg.eventType, startMs: seg.startMs, endMs: seg.endMs, label: seg.label, score: 1, scoreBreakdown: {}, entityIds: seg.entityIds };
}

/** "Show me X" means play it: seek to the grounded moment and resume if the player was paused (e.g. by the Lens). */
async function showMoment(c: SkillCtx, ms: number): Promise<PlayerState> {
  const s = await seekTo(c, ms);
  if (s.paused) return c.call("player.play");
  return s;
}

async function seekTo(c: SkillCtx, ms: number): Promise<PlayerState> {
  c.session.lastSeekTargetMs = ms;
  const s = await c.call("player.seek", { positionMs: Math.max(0, Math.round(ms)) });
  c.step({ kind: "action", label: `seek → ${formatMs(ms)}`, component: `player:${s.deviceKind ?? "?"}` });
  return s;
}

async function groundMoment(c: SkillCtx, m: Moment, how: "semantic_seek") {
  c.session.ground({ kind: "moment", label: m.label, moment: m });
  const ent = primaryEntity(c, m);
  if (ent) c.session.activeEntityId = ent;
  await c.app.record({ type: how, contentId: c.envelope.relevantCore.contentId, contentTimeMs: m.startMs, summary: `Went to ${m.label}`, entityIds: m.entityIds.filter(isPersonId), payload: { segmentId: m.segmentId } });
}

async function runIntent(intent: Intent, c: SkillCtx) {
  const index = c.app.currentIndex();
  switch (intent.type) {
    case "seek_moment": {
      const m = await resolveMoment(c, intent.spec);
      await showMoment(c, m.startMs);
      await groundMoment(c, m, "semantic_seek");
      c.speech.push(`${m.label}.`);
      c.cards.push({ type: "moment", title: m.label, subtitle: `${formatMs(m.startMs)}–${formatMs(m.endMs)} · score ${m.score}`, startMs: m.startMs, endMs: m.endMs });
      return;
    }
    case "list_moments": {
      const spec = intent.spec;
      const entityIds = entityIdsFor(c, spec);
      const r: SearchResult = await search(c, {
        query: spec.query,
        eventTypes: spec.replay ? ["replay"] : spec.eventTypes,
        entityIds,
        order: "chronological",
        limit: 10,
        // shots by a player: the player must be the one shooting, which the parser can't tell — entity filter is enough here
      });
      if (!r.moments.length) noResult(c, r, "any matching moments");
      c.session.ground({ kind: "result_set", label: spec.query, results: r.moments, resultIndex: 0 });
      if (entityIds?.length === 1) c.session.activeEntityId = entityIds[0];
      await showMoment(c, r.moments[0].startMs);
      await c.app.record({ type: "moments_listed", contentId: c.envelope.relevantCore.contentId, contentTimeMs: r.moments[0].startMs, summary: `Listed ${r.moments.length} × ${spec.query}`, entityIds: entityIds ?? [], payload: { count: r.moments.length } });
      const n = r.moments.length;
      c.speech.push(`Found ${n} so far${r.hiddenBySpoilerBoundary ? " (not counting anything you haven't watched yet)" : ""}. Playing the first one.`);
      c.cards.push({ type: "moments", title: `${n} moment${n > 1 ? "s" : ""}`, items: r.moments.map((m) => ({ label: m.label, startMs: m.startMs, endMs: m.endMs })), selected: 0 });
      return;
    }
    case "select_result": {
      const set = c.session.lastResultSet;
      if (!set?.results?.length) throw new Error("there's no list of moments to pick from yet");
      const cur = set.resultIndex ?? 0;
      const n = set.results.length;
      const i = intent.which === "next" ? cur + 1 : intent.which === "previous" ? cur - 1 : intent.which === "last" ? n - 1 : intent.which - 1;
      if (i < 0 || i >= n) throw new Error(`there are only ${n} in that list`);
      const m = set.results[i];
      c.session.ground({ ...set, resultIndex: i });
      c.step({ kind: "intent", label: `result ${i + 1}/${n} of “${set.label}”`, component: "context-service" });
      await showMoment(c, m.startMs);
      c.speech.push(`${m.label}.`);
      c.cards.push({ type: "moments", title: `${i + 1} of ${n}`, items: set.results.map((x) => ({ label: x.label, startMs: x.startMs, endMs: x.endMs })), selected: i });
      return;
    }
    case "relative_seek": {
      const active = c.session.activeMoment;
      const base = intent.base === "grounded" ? (c.session.lastSeekTargetMs ?? active?.startMs ?? pos(c)) : pos(c);
      const target = Math.max(0, base + intent.deltaMs);
      c.step({ kind: "intent", label: `${formatMs(base)} ${intent.deltaMs < 0 ? "−" : "+"} ${Math.abs(intent.deltaMs) / 1000}s = ${formatMs(target)} (no model call)`, component: "deterministic" });
      await seekTo(c, target);
      // The grounded moment now starts here, so later "clip it" / "repeat it" use the adjusted start.
      if (intent.base === "grounded" && active) c.session.ground({ kind: "moment", label: active.label, moment: { ...active, startMs: target } });
      await c.app.record({ type: "relative_seek", contentId: c.envelope.relevantCore.contentId, contentTimeMs: target, summary: `Moved ${intent.deltaMs / 1000}s`, entityIds: [], payload: {} });
      c.speech.push(`${Math.abs(intent.deltaMs / 1000)} seconds ${intent.deltaMs < 0 ? "earlier" : "later"}.`);
      return;
    }
    case "set_speed": {
      const cur = c.app.bridge.state()?.rate ?? 1;
      const rate = intent.rate === "slower" ? (cur <= 0.5 ? 0.25 : 0.5) : intent.rate === "faster" ? Math.min(2, cur < 1 ? 1 : 1.5) : intent.rate;
      await c.call("player.set_speed", { rate: +rate.toFixed(3) });
      await c.app.record({ type: "speed_change", contentId: c.envelope.relevantCore.contentId, contentTimeMs: pos(c), summary: `Speed ${rate}×`, entityIds: [], payload: { rate } });
      c.speech.push(rate === 1 ? "Normal speed." : `${+rate.toFixed(2)}× speed.`);
      return;
    }
    case "loop":
    case "again": {
      const m = c.session.activeMoment;
      const start = c.session.lastSeekTargetMs ?? m?.startMs ?? Math.max(0, pos(c) - 8000);
      const end = m ? Math.max(m.endMs, start + 2000) : pos(c);
      if (intent.type === "loop") {
        await c.call("player.loop", { startMs: start, endMs: end, count: intent.count });
        c.speech.push(`Playing it ${intent.count} times.`);
        await c.app.record({ type: "loop_moment", contentId: c.envelope.relevantCore.contentId, contentTimeMs: start, summary: `Looped ${m?.label ?? formatMs(start)} ${intent.count}×`, entityIds: m?.entityIds.filter(isPersonId) ?? [], payload: { count: intent.count } });
      } else {
        await c.call("player.play_segment", { startMs: start, endMs: end });
        c.speech.push("Again.");
        await c.app.record({ type: "rewatch_moment", contentId: c.envelope.relevantCore.contentId, contentTimeMs: start, summary: `Rewatched ${m?.label ?? formatMs(start)}`, entityIds: m?.entityIds.filter(isPersonId) ?? [], payload: {} });
      }
      c.step({ kind: "action", label: `${intent.type} ${formatMs(start)}–${formatMs(end)}`, component: "player" });
      return;
    }
    case "clear_loop":
      await c.call("player.clear_loop");
      c.speech.push("Stopped repeating.");
      return;
    case "pause":
      await c.call("player.pause");
      c.speech.push("Paused.");
      return;
    case "play":
      await c.call("player.play");
      c.speech.push("Playing.");
      return;
    case "return_live": {
      const to = c.session.watchedUpToMs;
      await c.call("player.clear_loop");
      await c.call("player.set_speed", { rate: 1 });
      await seekTo(c, to);
      await c.call("player.play");
      c.speech.push(`Back to where you were, ${formatMs(to)}.`);
      return;
    }
    case "identify": {
      await freezeFrame(c);
      if (isNarrative(index)) {
        let entityId: string | undefined;
        if (intent.target === "mention") {
          const r = await c.call("entities.resolve", { mention: intent.mention ?? "", atMs: pos(c) });
          entityId = r.resolutions.find((x: { type: string }) => x.type === "character")?.id ?? r.resolutions[0]?.id;
          if (!entityId) throw new Error("I couldn't tell who you mean");
        } else if (intent.target === "pronoun" && c.session.activeEntityId?.startsWith("character:")) entityId = c.session.activeEntityId;
        const r = await c.call("lens.identify", entityId ? { target: "entity", entityId, atMs: pos(c) } : { target: "on_screen", atMs: pos(c) });
        const e = r.entity;
        if (!e) {
          c.speech.push(cap(r.facts[0] ?? "I don't recognise anyone here."));
          c.cards.push({ type: "text", title: "On screen", body: r.facts.join("\n") });
          return;
        }
        if (e.type === "character" || e.type === "person") c.session.activeEntityId = e.id;
        c.session.ground({ kind: "entity", label: e.name, entityId: e.id, moment: c.session.activeMoment ?? undefined });
        await c.app.record({ type: "who_is_this", contentId: c.envelope.relevantCore.contentId, contentTimeMs: pos(c), summary: `Asked about ${e.name}${e.role ? ` (${e.role})` : ""}`, entityIds: [e.id], payload: { source: r.provenance.source } });
        // Spoken answer stays short: who, and how we know. Appearances and links are on the card.
        const how = (r.facts as string[]).find((f) => /^recognised/i.test(f));
        c.speech.push(`That's ${e.name}${e.role ? `, the ${e.role}` : ""}.${how ? ` ${cap(how)}.` : ""}`.trim());
        c.cards.push({ type: "entity", title: e.name, subtitle: e.role, facts: [...r.facts, `source: ${r.provenance.source}`] });
        return;
      }
      let entityId: string | undefined;
      let target: "ball_carrier" | "entity" = "entity";
      if (intent.target === "ball_carrier") target = "ball_carrier";
      else if (intent.target === "pronoun") entityId = c.session.activeEntityId ?? undefined;
      else if (intent.target === "scorer") {
        const active = c.session.activeMoment;
        let goal = active && (active.eventType === "goal" || active.kind === "replay") ? active : null;
        if (!goal) goal = (await search(c, { query: "goal", eventTypes: ["goal"], relation: "before", order: "nearest", limit: 1 })).moments[0] ?? null;
        if (!goal) throw new Error("no goal has been scored yet");
        entityId = primaryEntity(c, goal) ?? undefined;
      } else {
        const r = await c.call("entities.resolve", { mention: intent.mention ?? "", atMs: pos(c) });
        entityId = r.resolutions[0]?.id;
        if (!entityId) throw new Error("I couldn't tell who you mean");
      }
      if (target === "entity" && !entityId) target = "ball_carrier";
      const r = await c.call("lens.identify", { target, entityId, atMs: pos(c) });
      const e = r.entity;
      c.session.activeEntityId = e.id;
      c.session.ground({ kind: "entity", label: e.name, entityId: e.id, moment: c.session.activeMoment ?? undefined });
      await c.app.record({ type: "who_is_this", contentId: c.envelope.relevantCore.contentId, contentTimeMs: pos(c), summary: `Asked about ${e.name} (#${e.number}, ${e.team})`, entityIds: [e.id], payload: { source: r.provenance.source } });
      c.speech.push(`That's ${e.name}, number ${e.number} for ${e.team}. ${r.facts[0] ? `${cap(r.facts[0])}.` : ""}`);
      c.cards.push({ type: "entity", title: `${e.name} #${e.number}`, subtitle: `${e.team} · ${e.role}`, facts: [...r.facts, `source: ${r.provenance.source}`] });
      return;
    }
    case "read_text": {
      await freezeFrame(c);
      const r = await c.call("lens.read_text", { atMs: pos(c) });
      if (isNarrative(index)) {
        if (!r.text) throw new Error("there's no text on screen right now");
        await c.app.record({ type: "ocr_read", contentId: c.envelope.relevantCore.contentId, contentTimeMs: pos(c), summary: `Read on-screen text: ${r.text}`, entityIds: [], payload: {} });
        c.speech.push(`It says: ${r.items.map((i: { text: string }) => i.text).join(". ")}`);
        c.cards.push({ type: "text", title: "On screen", body: r.items.map((i: { text: string; kind?: string }) => `${i.kind ?? "text"}: ${i.text}`).join("\n") });
        return;
      }
      if (!r.text) throw new Error("there's no scoreboard on screen");
      await c.app.record({ type: "ocr_read", contentId: c.envelope.relevantCore.contentId, contentTimeMs: pos(c), summary: `Read scoreboard: ${r.text}`, entityIds: [], payload: {} });
      const [home, away] = index!.teams;
      c.speech.push(`${home.name} ${r.home}, ${away.name} ${r.away}, ${r.clock.replace("'", "")} minutes played.`);
      c.cards.push({ type: "text", title: "On screen", body: `${r.text} · ${r.clock}` });
      return;
    }
    case "what_said": {
      const p = pos(c);
      const r = await c.call("transcript.window", { fromMs: p - 15000, toMs: p });
      const lines = r.lines.slice(-2);
      if (!lines.length) throw new Error("nothing was said in the last few seconds");
      await c.app.record({ type: "transcript_request", contentId: c.envelope.relevantCore.contentId, contentTimeMs: p, summary: "Asked what was said", entityIds: [], payload: {} });
      if (isNarrative(index)) {
        const last = lines[lines.length - 1];
        c.speech.push(`${last.speakerName} said: ${last.text}`);
        c.cards.push({ type: "text", title: "Dialogue", body: lines.map((l: { text: string; startMs: number; speakerName: string }) => `${formatMs(l.startMs)}  ${l.speakerName}: ${l.text}`).join("\n") });
        return;
      }
      c.speech.push(`The commentator said: ${lines.map((l: { text: string }) => l.text).join(" ")}`);
      c.cards.push({ type: "text", title: "Commentary", body: lines.map((l: { text: string; startMs: number }) => `${formatMs(l.startMs)}  ${l.text}`).join("\n") });
      return;
    }
    case "describe": {
      const p = pos(c);
      const r = await c.call("moments.summarize", { fromMs: Math.max(0, p - 25000), toMs: p });
      const who = c.envelope.relevantCore.currentEntities[0];
      await c.app.record({ type: "accessibility_description", contentId: c.envelope.relevantCore.contentId, contentTimeMs: p, summary: "Asked for a description", entityIds: [], payload: {} });
      const onScreen = c.envelope.relevantCore.currentEntities.map((e) => e.name);
      if (isNarrative(index)) c.speech.push(`${r.summary}${onScreen.length ? ` On screen now: ${onScreen.join(" and ")}.` : ""}`);
      else c.speech.push(`${r.summary}${who ? ` Right now ${who.name} is on the ball.` : ""}`);
      c.cards.push({ type: "text", title: "What just happened", body: r.summary });
      return;
    }
    case "catch_up": {
      const p = pos(c);
      const r = await c.call("moments.summarize", { fromMs: Math.max(0, p - intent.windowMs), toMs: p });
      await c.app.record({ type: "catch_up_generated", contentId: c.envelope.relevantCore.contentId, contentTimeMs: p, summary: `Catch-up over ${intent.windowMs / 60000} min: ${r.summary}`, entityIds: [], payload: { events: r.events.length } });
      c.speech.push(`Here's what you missed. ${r.summary}`);
      c.cards.push({ type: "moments", title: `Catch me up · last ${Math.round(intent.windowMs / 60000) || 1} min`, items: r.events.map((e: { description: string; atMs: number }) => ({ label: e.description, startMs: e.atMs, endMs: e.atMs + 5000 })) });
      if (r.highlights.length) c.session.ground({ kind: "result_set", label: "catch-up highlights", results: r.highlights.map((h: Moment) => ({ ...h, segmentId: h.segmentId ?? h.eventId, kind: "event", score: 1, scoreBreakdown: {}, entityIds: [], eventType: h.eventType ?? "goal" })), resultIndex: 0 });
      return;
    }
    case "clip": {
      let m = c.session.activeMoment;
      if (intent.spec) m = await resolveMoment(c, intent.spec);
      const start = intent.spec ? m!.startMs : (c.session.lastSeekTargetMs ?? m?.startMs ?? Math.max(0, pos(c) - 10000));
      const end = m ? Math.max(m.endMs, start + 3000) : pos(c);
      const r = await c.call("clip.create", { startMs: start, endMs: Math.min(end, start + 60000), label: m?.label });
      const clip: ClipRecord = r.clip;
      c.session.ground({ kind: "clip", label: clip.label, clipId: clip.clipId, moment: m ?? undefined });
      c.speech.push(`Clipped ${clip.label} (${Math.round((clip.endMs - clip.startMs) / 1000)} seconds).`);
      const card: AnswerCard = { type: "clip", title: clip.label, clip };
      c.cards.push(card);
      if (intent.share) await share(c, clip, card);
      return;
    }
    case "share": {
      let clip = c.session.clips[c.session.clips.length - 1];
      if (!clip || (c.session.activeRef?.kind !== "clip" && c.session.activeMoment && clip.startMs !== c.session.activeMoment.startMs)) {
        await runIntent({ type: "clip", share: true }, c);
        return;
      }
      const card = c.cards.find((x): x is Extract<AnswerCard, { type: "clip" }> => x.type === "clip" && x.clip.clipId === clip.clipId);
      await share(c, clip, card ?? null);
      return;
    }
    case "memory_query": {
      const r = await c.call("memory.search", { query: intent.text, types: intent.types.length ? intent.types : undefined, limit: 5 });
      const items = r.results as { summary: string; wallClock: string; contentTimeMs: number | null }[];
      if (!items.length) {
        c.speech.push("I don't have anything like that in your viewing history yet.");
        return;
      }
      await c.app.record({ type: "memory_query", contentId: c.envelope.relevantCore.contentId, contentTimeMs: pos(c), summary: `Asked: ${intent.text}`, entityIds: [], payload: {} });
      c.speech.push(`${items[0].summary} — ${relTime(items[0].wallClock)}.`);
      c.cards.push({ type: "memory", title: "From your Viewing Memory", items: items.map((i) => ({ summary: i.summary, at: i.wallClock, contentTimeMs: i.contentTimeMs })) });
      return;
    }
    case "open_content": {
      const r = await c.call("content.open", { query: intent.query });
      await c.app.record({ type: "content_opened", contentId: r.contentId, contentTimeMs: 0, summary: `Opened ${r.title}`, entityIds: [], payload: { kind: r.kind } });
      c.speech.push(`Opening ${r.title}.`);
      c.cards.push({ type: "text", title: r.title, body: `${r.kind === "narrative" ? "Film" : "Match"} · ${formatMs(r.durationMs)}` });
      return;
    }
    case "spoilers":
      c.session.spoilerMode = intent.mode;
      c.speech.push(intent.mode === "full" ? "Spoiler protection is off." : "Spoiler protection is on — I'll only use what you've already watched.");
      return;
    case "unknown":
      return;
  }
}

/**
 * Viewing Lens answers are about the frame the viewer asked about. Pause first (as visual-search
 * features do), so the answer can never describe a shot that has already cut away.
 */
async function freezeFrame(c: SkillCtx) {
  const s = c.app.bridge.state();
  if (s && !s.paused) {
    await c.call("player.pause");
    c.step({ kind: "action", label: `paused on the frame you asked about (${formatMs(s.positionMs)})`, component: "player" });
  }
}

async function share(c: SkillCtx, clip: ClipRecord, card: Extract<AnswerCard, { type: "clip" }> | null) {
  const r = await c.call("share.send", { clipId: clip.clipId, destination: "phone" });
  const full = c.app.shares.find((s) => s.shareId === r.share.shareId);
  if (card && full) card.share = full;
  else if (full) c.cards.push({ type: "clip", title: clip.label, clip, share: full });
  c.speech.push("Sent to your phone.");
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function relTime(iso: string) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 90) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} minutes ago`;
  if (d < 86400) return `${Math.round(d / 3600)} hours ago`;
  return `${Math.round(d / 86400)} days ago`;
}

/** Keep trace payloads readable: the important 1–4 fields per tool (Demo Video rule). */
function summarize(name: string, d: any): unknown {
  if (d?.error) return d;
  switch (name) {
    case "moments.search":
      return {
        top: d.moments?.slice(0, 3).map((m: Moment) => ({ label: m.label, startMs: m.startMs, score: m.score, breakdown: m.scoreBreakdown })),
        count: d.moments?.length,
        hiddenBySpoilerBoundary: d.hiddenBySpoilerBoundary,
        embeddingModel: d.embeddingModel,
        constraints: d.constraints,
      };
    case "clip.create":
      return { clipId: d.clip?.clipId, startMs: d.clip?.startMs, endMs: d.clip?.endMs, renderer: d.clip?.renderer, renderMs: d.clip?.renderMs, mediaConvertEquivalent: d.mediaConvertEquivalent };
    case "player.seek":
    case "player.set_speed":
    case "player.loop":
    case "player.play_segment":
    case "player.play":
    case "player.pause":
    case "player.clear_loop":
      return { deviceKind: d.deviceKind, positionMs: d.positionMs, rate: d.rate, paused: d.paused, loop: d.loop };
    default:
      return d;
  }
}

function stripHeavy(card: AnswerCard): AnswerCard {
  if (card.type === "clip" && card.share) return { ...card, share: { ...card.share, qrSvg: "" } };
  return card;
}
