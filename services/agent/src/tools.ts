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
import { type ClipRecord, type ShareRecord, entityIdForPlayer, formatMs } from "../../../packages/contracts/src/index.ts";
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
    wrap(async ({ positionMs }: { positionMs: number }) => app.bridge.send({ cmd: "seek", positionMs: Math.round(positionMs) })),
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
        eventTypes: z.array(z.string()).optional().describe("goal, replay, save, shot, yellow_card, foul, corner, header, free_kick, celebration, kickoff, tackle, interception, clearance, final_whistle"),
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
          return { eventId: e.id, startMs: seg.startMs, endMs: seg.endMs, label: seg.label };
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
        "Identify a player on screen: the ball carrier at a time, or a given entity. Facts are bounded by the spoiler boundary. " +
        "Source: provider tracking feed + roster (no face recognition is used for this synthetic match).",
      inputSchema: { target: z.enum(["ball_carrier", "entity"]), entityId: z.string().optional(), atMs: z.number().optional() },
    },
    wrap(async ({ target, entityId, atMs }: { target: "ball_carrier" | "entity"; entityId?: string; atMs?: number }) => {
      const idx = requireIndex(app);
      const session = app.sessions.get();
      const at = atMs ?? app.bridge.state()?.positionMs ?? 0;
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
      return { source: idx.sources.transcript, lines: idx.transcript.filter((l) => l.endMs >= fromMs && l.startMs <= toMs) };
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
  "player.get_state", "player.seek", "player.play", "player.pause", "player.set_speed", "player.play_segment", "player.loop", "player.clear_loop",
  "entities.resolve", "moments.search", "moments.summarize", "lens.identify", "lens.read_text", "transcript.window", "memory.search", "clip.create", "share.send",
] as const;
