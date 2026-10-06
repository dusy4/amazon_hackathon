/**
 * Semantic Playback MCP tool surface (v2 "Agent / MCP tool surface").
 *
 * Player primitives are deterministic and execute on the real player through the PlayerBridge.
 * The agent reasons over references; these tools ground and act.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import QRCode from "qrcode";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ClipRecord, type ContentIndex, type ShareRecord, entityIdForPlayer, formatMs, isNarrative } from "../../../packages/contracts/src/index.ts";
import { clipAttribution, renderClip, toMediaConvertInput } from "../../media/src/clip.ts";
import type { AppContext } from "./app-context.ts";
import { resolveEntities } from "./entities.ts";

type Json = Record<string, unknown>;
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true });

function requireIndex(app: AppContext) {
  const idx = app.currentIndex();
  if (!idx) throw new Error("No indexed content. Run `npm run ingest` first.");
  return idx;
}

function clampRange(startMs: number, endMs: number, durationMs: number) {
  const s = Math.max(0, Math.min(startMs, durationMs - 500));
  return { startMs: s, endMs: Math.max(s + 500, Math.min(endMs, durationMs)) };
}

export function registerTools(server: McpServer, app: AppContext) {
  const wrap =
    <A,>(fn: (args: A) => Promise<unknown> | unknown) =>
    async (args: A) => {
      try {
        return ok(await fn(args));
      } catch (e) {
        return fail((e as Error).message);
      }
    };

  // ---------------------------------------------------------------- player primitives
  server.registerTool(
    "player.get_state",
    { title: "Get playback state", description: "Current content, position, rate, pause and loop state of the active player.", inputSchema: {} },
    wrap(async () => {
      const s = app.bridge.state();
      if (!s) throw new Error("No player connected.");
      return { ...s, watchedUpToMs: app.sessions.get().watchedUpToMs, devices: app.bridge.list() };
    }),
  );
  server.registerTool(
    "player.seek",
    { title: "Seek", description: "Seek the active player to an absolute position in milliseconds.", inputSchema: { positionMs: z.number().min(0) } },
    wrap(async ({ positionMs }: { positionMs: number }) => {
      const s = await app.bridge.send({ cmd: "seek", positionMs: Math.round(positionMs) });
      app.sessions.get().lastSeekTargetMs = Math.round(positionMs);
      return s;
    }),
  );
  server.registerTool(
    "player.seek_relative",
    {
      title: "Seek relative",
      description:
        "Move by deltaMs (negative = earlier). from='grounded' (default) moves relative to the last grounded moment / last seek target, " +
        "e.g. 'start three seconds before it' = -3000; from='position' moves relative to the current playhead, e.g. 'skip back 10 seconds'.",
      inputSchema: { deltaMs: z.number(), from: z.enum(["grounded", "position"]).optional() },
    },
    wrap(async ({ deltaMs, from }: { deltaMs: number; from?: "grounded" | "position" }) => {
      const session = app.sessions.get();
      const here = app.bridge.state()?.positionMs ?? 0;
      const active = session.activeMoment;
      const base = from === "position" ? here : (session.lastSeekTargetMs ?? active?.startMs ?? here);
      const target = Math.max(0, Math.round(base + deltaMs));
      const s = await app.bridge.send({ cmd: "seek", positionMs: target });
      session.lastSeekTargetMs = target;
      // The grounded moment now starts here, so "clip it" / "repeat it" use the adjusted start.
      if (from !== "position" && active) session.ground({ kind: "moment", label: active.label, moment: { ...active, startMs: target } });
      await app.record({ type: "relative_seek", contentId: app.currentIndex()?.contentId ?? null, contentTimeMs: target, summary: `Moved ${deltaMs / 1000}s`, entityIds: [], payload: { base } });
      return { ...s, baseMs: base, targetMs: target };
    }),
  );
  server.registerTool("player.play", { title: "Play", description: "Resume playback.", inputSchema: {} }, wrap(async () => app.bridge.send({ cmd: "play" })));
  server.registerTool("player.pause", { title: "Pause", description: "Pause playback.", inputSchema: {} }, wrap(async () => app.bridge.send({ cmd: "pause" })));
  server.registerTool(
    "player.set_speed",
    { title: "Set speed", description: "Set playback rate (0.25–2). 0.5 = half speed.", inputSchema: { rate: z.number().min(0.25).max(2) } },
    wrap(async ({ rate }: { rate: number }) => app.bridge.send({ cmd: "set_rate", rate })),
  );
  server.registerTool(
    "player.play_segment",
    { title: "Play segment", description: "Play [startMs, endMs] once, then pause.", inputSchema: { startMs: z.number().min(0), endMs: z.number().min(0) } },
    wrap(async ({ startMs, endMs }: { startMs: number; endMs: number }) => app.bridge.send({ cmd: "play_segment", startMs, endMs })),
  );
  server.registerTool(
    "player.loop",
    {
      title: "Loop segment",
      description: "Play [startMs, endMs] `count` times in total, then continue normal playback.",
      inputSchema: { startMs: z.number().min(0), endMs: z.number().min(0), count: z.number().int().min(1).max(50) },
    },
    wrap(async ({ startMs, endMs, count }: { startMs: number; endMs: number; count: number }) => app.bridge.send({ cmd: "loop", startMs, endMs, count })),
  );
  server.registerTool(
    "player.clear_loop",
    { title: "Stop looping", description: "Cancel an active loop/segment.", inputSchema: {} },
    wrap(async () => app.bridge.send({ cmd: "clear_loop" })),
  );

  // ---------------------------------------------------------------- grounding
  server.registerTool(
    "entities.resolve",
    {
      title: "Resolve entity mention",
      description: "Map a mention (name, shirt number, role, team) to canonical entity IDs using the current title's roster and recent involvement.",
      inputSchema: { mention: z.string(), atMs: z.number().optional() },
    },
    wrap(async ({ mention, atMs }: { mention: string; atMs?: number }) => {
      const idx = requireIndex(app);
      const at = atMs ?? app.bridge.state()?.positionMs ?? 0;
      return { resolutions: resolveEntities(idx, mention, at).map((r) => ({ ...r.entity, matchedBy: r.matchedBy, confidence: r.confidence })) };
    }),
  );

  server.registerTool(
    "moments.search",
    {
      title: "Search moments",
      description:
        "Hybrid (semantic + lexical + entity + event-type) search over the indexed timeline with deterministic temporal constraints. " +
        "Returns grounded segments (startMs/endMs), not just text. Respects the spoiler boundary unless respectSpoilers=false.",
      inputSchema: {
        query: z.string().describe("natural-language description of the moment"),
        eventTypes: z
          .array(z.string())
          .optional()
          .describe("sports: goal, replay, save, shot, yellow_card, foul, corner, header, free_kick, celebration, kickoff, tackle, interception, clearance, final_whistle; narrative: scene, beat"),
        entityIds: z.array(z.string()).optional(),
        entityNames: z.array(z.string()).optional().describe("names/numbers to resolve into entityIds, e.g. 'Silva', '#9 Northgate'"),
        replayOfEventId: z.string().optional(),
        relation: z.enum(["before", "after", "any"]).optional(),
        anchorMs: z.number().optional(),
        order: z.enum(["relevance", "nearest", "chronological", "first", "last"]).optional(),
        ordinal: z.number().int().min(1).optional(),
        includeWindows: z.boolean().optional(),
        respectSpoilers: z.boolean().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    wrap(async (a: Json) => {
      const idx = requireIndex(app);
      const pos = app.bridge.state()?.positionMs ?? 0;
      const session = app.sessions.get();
      const entityIds = [...((a.entityIds as string[]) ?? [])];
      for (const n of (a.entityNames as string[]) ?? []) for (const r of resolveEntities(idx, n, pos)) entityIds.push(r.entity.id);
      const strict = session.spoilerMode === "strict" && a.respectSpoilers !== false;
      return app.retriever.search(
        idx,
        {
          query: String(a.query ?? ""),
          eventTypes: a.eventTypes as string[] | undefined,
          entityIds: entityIds.length ? [...new Set(entityIds)] : undefined,
          replayOfEventId: a.replayOfEventId as string | undefined,
          relation: a.relation as "before" | "after" | "any" | undefined,
          anchorMs: a.anchorMs as number | undefined,
          order: a.order as "nearest" | undefined,
          ordinal: a.ordinal as number | undefined,
          includeWindows: a.includeWindows as boolean | undefined,
          limit: a.limit as number | undefined,
          spoilerBoundaryMs: strict ? Math.max(session.watchedUpToMs, pos) : undefined,
        },
        pos,
      );
    }),
  );

  server.registerTool(
    "moments.summarize",
    {
      title: "Summarise a time window (Catch Me Up)",
      description: "Key events, score change and commentary between fromMs and toMs, ranked by importance. Never reads past the spoiler boundary.",
      inputSchema: { fromMs: z.number().min(0), toMs: z.number().min(0) },
    },
    wrap(async ({ fromMs, toMs }: { fromMs: number; toMs: number }) => {
      const idx = requireIndex(app);
      const session = app.sessions.get();
      const pos = app.bridge.state()?.positionMs ?? 0;
      const to = session.spoilerMode === "strict" ? Math.min(toMs, Math.max(session.watchedUpToMs, pos)) : toMs;
      if (isNarrative(idx)) {
        const beats = idx.events.filter((e) => e.type === "beat" && e.startMs >= fromMs && e.startMs <= to);
        const scenes = idx.events.filter((e) => e.type === "scene" && e.endMs > fromMs && e.startMs <= to);
        const summary = beats.length
          ? `${beats.map((b) => b.description).join(". ")}.`
          : scenes.length
            ? `${scenes.map((s) => s.description).join(" ")}`
            : `Nothing happened between ${formatMs(fromMs)} and ${formatMs(to)}.`;
        const highlights = beats.map((b) => {
          const seg = idx.segments.find((s) => s.eventId === b.id)!;
          return { eventId: b.id, eventType: "beat", startMs: seg.startMs, endMs: seg.endMs, label: seg.label };
        });
        return { fromMs, toMs: to, events: [...scenes, ...beats].sort((a, b) => a.startMs - b.startMs).map((e) => ({ id: e.id, type: e.type, atMs: e.startMs, description: e.type === "scene" ? `Scene: ${e.title}` : e.description })), highlights, summary };
      }
      const weight: Record<string, number> = { goal: 10, yellow_card: 6, save: 5, shot: 4, header: 3, foul: 2, corner: 1, final_whistle: 8 };
      const evs = idx.events
        .filter((e) => e.startMs >= fromMs && e.startMs <= to && weight[e.type])
        .sort((a, b) => weight[b.type] - weight[a.type] || a.startMs - b.startMs)
        .slice(0, 5)
        .sort((a, b) => a.startMs - b.startMs);
      const scoreAt = (ms: number) => idx.scoreboard.find((s) => s.startMs <= ms && ms < s.endMs) ?? idx.scoreboard[0];
      const before = scoreAt(fromMs);
      const after = scoreAt(to);
      const goalMoments = evs
        .filter((e) => e.type === "goal")
        .map((e) => {
          const seg = idx.segments.find((s) => s.eventId === e.id)!;
          return { eventId: e.id, eventType: "goal", startMs: seg.startMs, endMs: seg.endMs, label: seg.label };
        });
      const summary =
        evs.length === 0
          ? `Nothing major between ${formatMs(fromMs)} and ${formatMs(to)}. Still ${after.text}.`
          : `${evs.map((e) => e.description.replace(/\s*\(.*?\)/g, "")).join(" ")} ` +
            (before.text !== after.text ? `Score went from ${before.text} to ${after.text}.` : `Score still ${after.text}.`);
      return { fromMs, toMs: to, events: evs.map((e) => ({ id: e.id, type: e.type, atMs: e.startMs, description: e.description })), highlights: goalMoments, scoreBefore: before.text, scoreAfter: after.text, summary };
    }),
  );

  // ---------------------------------------------------------------- Viewing Lens
  server.registerTool(
    "lens.identify",
    {
      title: "Identify (Viewing Lens)",
      description:
        "Identify who is on screen: the ball carrier (sports), the person speaking / on screen (narrative), or a given entity. " +
        "Facts are bounded by the spoiler boundary. Source: provider tracking/presence feed + cast list (no face recognition is used for the synthetic titles).",
      inputSchema: { target: z.enum(["ball_carrier", "on_screen", "entity"]), entityId: z.string().optional(), atMs: z.number().optional() },
    },
    wrap(async ({ target, entityId, atMs }: { target: "ball_carrier" | "on_screen" | "entity"; entityId?: string; atMs?: number }) => {
      const idx = requireIndex(app);
      const session = app.sessions.get();
      const at = atMs ?? app.bridge.state()?.positionMs ?? 0;
      if (isNarrative(idx)) return identifyCharacter(idx, target === "entity" ? entityId : undefined, at, session.spoilerMode === "strict" ? Math.max(session.watchedUpToMs, at) : Infinity);
      let id = entityId;
      let source = "roster";
      if (target === "ball_carrier") {
        const p = idx.possession.find((x) => x.startMs <= at && at < x.endMs) ?? [...idx.possession].reverse().find((x) => x.endMs <= at);
        if (!p) throw new Error("Nobody has the ball at this moment.");
        id = entityIdForPlayer(p.team, p.number);
        source = "provider-tracking (possession)";
      }
      const e = idx.entities.find((x) => x.id === id);
      if (!e) throw new Error(`Unknown entity ${id}`);
      const boundary = session.spoilerMode === "strict" ? Math.max(session.watchedUpToMs, at) : Infinity;
      const mine = (ev: (typeof idx.events)[number]) => ev.players.some((p) => entityIdForPlayer(p.team, p.number) === e.id) && ev.startMs <= boundary;
      const goals = idx.events.filter((ev) => ev.type === "goal" && ev.scorer && entityIdForPlayer(ev.scorer.team, ev.scorer.number) === e.id && ev.startMs <= boundary);
      const assists = idx.events.filter((ev) => ev.type === "goal" && ev.assist && entityIdForPlayer(ev.assist.team, ev.assist.number) === e.id && ev.startMs <= boundary);
      const cards = idx.events.filter((ev) => ev.type === "yellow_card" && mine(ev));
      const shots = idx.events.filter((ev) => ev.type === "shot" && mine(ev) && ev.players[0] && entityIdForPlayer(ev.players[0].team, ev.players[0].number) === e.id);
      const touches = idx.touches.filter((t) => entityIdForPlayer(t.team, t.number) === e.id && t.ms <= boundary).length;
      const team = idx.teams.find((t) => t.id === e.team);
      return {
        entity: { id: e.id, name: e.name, number: e.number, team: team?.name, role: e.role },
        facts: [
          goals.length ? `${goals.length} goal${goals.length > 1 ? "s" : ""} so far` : null,
          assists.length ? `${assists.length} assist${assists.length > 1 ? "s" : ""}` : null,
          shots.length ? `${shots.length} shot${shots.length > 1 ? "s" : ""}` : null,
          cards.length ? "booked (yellow card)" : null,
          `${touches} touches so far`,
        ].filter(Boolean),
        provenance: { source, epistemicType: "provider_metadata", confidence: 1, spoilerScope: "safe_before_playhead", observedAtMs: at },
      };
    }),
  );

  server.registerTool(
    "lens.read_text",
    {
      title: "Read on-screen text",
      description: "Read the scoreboard/clock text visible at a time. Source: provider scoreboard feed (Rekognition DetectText is the camera-frame path).",
      inputSchema: { atMs: z.number().optional() },
    },
    wrap(async ({ atMs }: { atMs?: number }) => {
      const idx = requireIndex(app);
      const at = atMs ?? app.bridge.state()?.positionMs ?? 0;
      if (isNarrative(idx)) {
        const visible = (idx.signs ?? []).filter((s) => s.startMs <= at && at < s.endMs);
        // Close-ups (letters, maps) are what the viewer is looking at; scene signs come after.
        visible.sort((a, b) => Number(a.kind === "sign") - Number(b.kind === "sign"));
        return { atMs: at, text: visible.map((s) => s.text).join(" · ") || null, items: visible, source: idx.sources.screenText };
      }
      const sb = idx.scoreboard.find((s) => s.startMs <= at && at < s.endMs);
      const minute = Math.floor((at / idx.durationMs) * 90);
      return { atMs: at, text: sb?.text ?? null, clock: `${minute}'`, home: sb?.home, away: sb?.away, source: idx.sources.screenText };
    }),
  );

  server.registerTool(
    "transcript.window",
    { title: "Transcript window", description: "Commentary/dialogue lines between fromMs and toMs.", inputSchema: { fromMs: z.number(), toMs: z.number() } },
    wrap(async ({ fromMs, toMs }: { fromMs: number; toMs: number }) => {
      const idx = requireIndex(app);
      const speakerName = (sp: string) => idx.entities.find((e) => e.id === `character:${sp}`)?.name ?? sp;
      return { source: idx.sources.transcript, lines: idx.transcript.filter((l) => l.endMs >= fromMs && l.startMs <= toMs).map((l) => ({ ...l, speakerName: speakerName(l.speaker) })) };
    }),
  );

  // ---------------------------------------------------------------- catalogue
  server.registerTool(
    "content.open",
    {
      title: "Open a title",
      description: "Load an indexed title on the active player (by contentId, or by a spoken description such as 'the match' or 'the keeper's key').",
      inputSchema: { contentId: z.string().optional(), query: z.string().optional(), positionMs: z.number().min(0).optional() },
    },
    wrap(async ({ contentId, query, positionMs }: { contentId?: string; query?: string; positionMs?: number }) => {
      const idx = app.store.get(contentId) ?? (query ? app.findContent(query) : undefined);
      if (!idx) throw new Error(`No indexed title matches “${contentId ?? query}”. Available: ${app.store.list().map((c) => c.title).join(", ")}`);
      app.currentContentId = idx.contentId;
      const state = await app.bridge.send({ cmd: "load", contentId: idx.contentId, url: `/media/${idx.contentId}/${idx.media}`, positionMs }, 15000);
      app.sessions.get().setContent(idx.contentId);
      return { contentId: idx.contentId, title: idx.title, kind: idx.kind, durationMs: idx.durationMs, state };
    }),
  );

  // ---------------------------------------------------------------- Viewing Memory
  server.registerTool(
    "memory.search",
    {
      title: "Search Viewing Memory",
      description: "Search the user's canonical activity log (seeks, identifications, clips, shares...).",
      inputSchema: { query: z.string(), types: z.array(z.string()).optional(), entityIds: z.array(z.string()).optional(), limit: z.number().int().optional() },
    },
    wrap(async ({ query, types, entityIds, limit }: { query: string; types?: string[]; entityIds?: string[]; limit?: number }) => {
      const s = app.sessions.get();
      const hits = await app.memory.search({ userId: s.userId, text: query, types: types as never, entityIds, limit: limit ?? 5 });
      return { backend: app.memory.backend, results: hits.map((h) => ({ ...h.event, score: +h.score.toFixed(3) })) };
    }),
  );

  // ---------------------------------------------------------------- clips + sharing
  server.registerTool(
    "clip.create",
    {
      title: "Create clip",
      description: "Render a server-side clip of [startMs, endMs] with watermark and source attribution + 'watch full' deep link.",
      inputSchema: { startMs: z.number().min(0), endMs: z.number().min(0), label: z.string().optional() },
    },
    wrap(async ({ startMs, endMs, label }: { startMs: number; endMs: number; label?: string }) => {
      const idx = requireIndex(app);
      const r = clampRange(startMs, endMs, idx.durationMs);
      if (r.endMs - r.startMs > 60000) throw new Error("Clips are limited to 60 seconds.");
      const clipId = `clip-${randomUUID().slice(0, 8)}`;
      const name = label ?? `${idx.title} ${formatMs(r.startMs)}`;
      const attribution = clipAttribution(idx.title, r.startMs);
      const res = await renderClip({ clipId, inputPath: app.store.mediaPath(idx), outDir: join(app.config.dataDir, "clips"), ...r, label: name, attribution });
      const base = app.config.publicBaseUrl;
      const clip: ClipRecord = {
        clipId,
        contentId: idx.contentId,
        ...r,
        label: name,
        url: `${base}/clips/${clipId}.mp4`,
        thumbnailUrl: `${base}/clips/${clipId}.jpg`,
        watchFullUrl: `${base}/tv?content=${idx.contentId}&t=${r.startMs}`,
        attribution,
        createdAt: new Date().toISOString(),
        renderer: res.renderer,
        renderMs: res.renderMs,
      };
      app.clips.set(clipId, clip);
      app.sessions.get().clips.push(clip);
      await app.record({ type: "clip_created", contentId: idx.contentId, contentTimeMs: r.startMs, summary: `Clipped "${name}"`, entityIds: [], payload: { clipId } });
      return { clip, mediaConvertEquivalent: toMediaConvertInput(`s3://<bucket>/${idx.contentId}/${idx.media}`, r.startMs, r.endMs) };
    }),
  );

  server.registerTool(
    "share.send",
    {
      title: "Send to phone",
      description: "Deliver a clip to the user's phone companion (realtime push + QR/deep link). Alexa Send to Phone is the future native path.",
      inputSchema: { clipId: z.string(), destination: z.enum(["phone"]).default("phone") },
    },
    wrap(async ({ clipId, destination }: { clipId: string; destination?: "phone" }) => {
      const clip = app.clips.get(clipId);
      if (!clip) throw new Error(`Unknown clip ${clipId}`);
      const deepLink = `${app.config.publicBaseUrl}/phone#clip=${clipId}`;
      const share: ShareRecord = {
        shareId: `share-${randomUUID().slice(0, 8)}`,
        clipId,
        destination: destination ?? "phone",
        deepLink,
        qrSvg: await QRCode.toString(deepLink, { type: "svg", margin: 1 }),
        createdAt: new Date().toISOString(),
        clip,
      };
      app.shares.push(share);
      app.emit({ type: "share", share });
      await app.record({ type: "clip_shared", contentId: clip.contentId, contentTimeMs: clip.startMs, summary: `Sent "${clip.label}" to phone`, entityIds: [], payload: { clipId, shareId: share.shareId } });
      return { share: { ...share, qrSvg: `<svg ${share.qrSvg.length} bytes>` }, deliveredTo: "companion web app (/phone) via WebSocket push", deepLink };
    }),
  );
}

export const TOOL_NAMES = [
  "player.get_state", "player.seek", "player.seek_relative", "player.play", "player.pause", "player.set_speed", "player.play_segment", "player.loop", "player.clear_loop",
  "entities.resolve", "moments.search", "moments.summarize", "lens.identify", "lens.read_text", "transcript.window", "memory.search", "clip.create", "share.send",
  "content.open",
] as const;

/** Narrative Viewing Lens: who is speaking / on screen, with spoiler-bounded facts from the cast list and timeline. */
function identifyCharacter(idx: ContentIndex, entityId: string | undefined, at: number, boundary: number) {
  let id = entityId;
  let source = "cast list";
  if (!id) {
    const speaking = idx.transcript.find((l) => l.startMs <= at && at < l.endMs + 800);
    const present = (idx.presence ?? []).filter((p) => p.startMs <= at && at < p.endMs);
    if (speaking && present.some((p) => p.entityId === `character:${speaking.speaker}`)) {
      id = `character:${speaking.speaker}`;
      source = "dialogue speaker + provider presence";
    } else if (present[0]) {
      const lastSpoke = [...idx.transcript].reverse().find((l) => l.startMs <= at && present.some((p) => p.entityId === `character:${l.speaker}`));
      id = lastSpoke ? `character:${lastSpoke.speaker}` : present[0].entityId;
      source = "provider presence";
    }
  }
  const e = idx.entities.find((x) => x.id === id);
  if (!e) throw new Error("Nobody is on screen right now.");
  const scenes = idx.events.filter((ev) => ev.type === "scene" && ev.startMs <= boundary && ev.entityIds?.includes(e.id));
  const speaker = e.id.replace(/^character:/, "");
  const lastLine = [...idx.transcript].reverse().find((l) => l.speaker === speaker && l.startMs <= boundary);
  const onScreen = (idx.presence ?? []).filter((p) => p.startMs <= at && at < p.endMs && p.entityId !== e.id).map((p) => p.name);
  return {
    entity: { id: e.id, type: e.type, name: e.name, role: e.role, description: e.description },
    facts: [
      e.description ?? null,
      scenes.length ? `in ${scenes.length} scene${scenes.length > 1 ? "s" : ""} so far (${scenes.map((s) => s.title).join(", ")})` : null,
      lastLine ? `last said: “${lastLine.text}”` : null,
      onScreen.length ? `on screen with ${onScreen.join(" and ")}` : null,
    ].filter(Boolean),
    provenance: { source, epistemicType: "provider_metadata", confidence: 1, spoilerScope: "safe_before_playhead", observedAtMs: at },
  };
}
