/**
 * Semantic Playback server: MCP (Streamable HTTP) + orchestrator API + player/UI WebSocket + static apps.
 *
 *   /tv        TV web player (simulated Alexa+-style voice/text client + pipeline view)
 *   /phone     phone companion (receives "send to phone" clips)
 *   /mcp       self-hosted MCP server
 *   /ws        player bridge + live trace stream
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import type { WireMessage } from "../../../packages/contracts/src/index.ts";
import { AppContext } from "./app-context.ts";
import { mountMcp } from "./mcp.ts";
import { Orchestrator } from "./orchestrator.ts";
import { ALLOWED_VOICES, POLLY_VOICE, synthesize } from "./tts.ts";

/** Best LAN address for QR codes / phones: prefer private home-network ranges over VPN/overlay ranges. */
function lanIp() {
  const all = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254"))
    .map((i) => i!.address);
  const rank = (a: string) => (a.startsWith("192.168.") ? 0 : a.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  return all.sort((a, b) => rank(a) - rank(b))[0] ?? "localhost";
}

export async function startServer(opts: { port?: number; dataDir?: string; host?: string } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const dataDir = resolve(opts.dataDir ?? process.env.SP_DATA_DIR ?? "data");
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://${lanIp()}:${port}`;
  const app = new AppContext({ dataDir, port, publicBaseUrl });
  // Warm the Viewing Memory store: the first DynamoDB call resolves credentials (~10 s with `aws login`),
  // which must not land on the viewer's first request.
  void app.memory.recent(app.sessions.get().userId, 1).catch(() => {});
  const orchestrator = new Orchestrator(app, `http://127.0.0.1:${port}/mcp`);

  const http = express();
  http.use(express.json({ limit: "1mb" }));
  mountMcp(http, app);

  const root = resolve(import.meta.dirname, "../../..");
  http.use("/tv", express.static(join(root, "apps/fire-tv/web")));
  http.use("/phone", express.static(join(root, "apps/companion")));
  http.use("/shared", express.static(join(root, "apps/shared")));
  // Lighter renditions for low-power players (e.g. `?v=480` → video.480.mp4 when present), like an ABR ladder rung.
  http.get("/media/:contentId/:file", (req, res, next) => {
    const v = typeof req.query.v === "string" && /^\d{3,4}$/.test(req.query.v) ? req.query.v : null;
    if (!v) return next();
    const alt = join(dataDir, "content", req.params.contentId, req.params.file.replace(/\.mp4$/, `.${v}.mp4`));
    if (!existsSync(alt)) return next();
    res.sendFile(alt);
  });
  // Closed captions for the Fire OS app (shown when the Fire TV CC setting is on): the title's WebVTT track.
  http.get("/media/:contentId/captions.vtt", (req, res) => {
    const dir = join(dataDir, "content", req.params.contentId);
    const vtt = ["video.en.vtt", "video.en-orig.vtt", "captions.vtt"].map((f) => join(dir, f)).find((f) => existsSync(f));
    if (!vtt) return res.status(404).end();
    res.type("text/vtt").sendFile(vtt);
  });
  http.use("/media", express.static(join(dataDir, "content")));
  http.use("/clips", express.static(join(dataDir, "clips")));
  http.get("/", (_req, res) => res.redirect("/tv/"));

  http.get("/api/health", (_req, res) =>
    res.json({ ok: true, interpreter: orchestrator.interpreterName, memory: app.memory.backend, players: app.bridge.list(), content: app.store.list().map((c) => c.contentId) }),
  );
  http.get("/api/content", (_req, res) =>
    res.json(app.store.list().map((c) => ({ contentId: c.contentId, title: c.title, kind: c.kind, durationMs: c.durationMs, url: `/media/${c.contentId}/${c.media}`, embeddingModel: c.embeddingModel, sources: c.sources }))),
  );
  http.get("/api/timeline/:contentId", (req, res) => {
    const c = app.store.get(req.params.contentId);
    if (!c) return void res.status(404).json({ error: "unknown content" });
    res.json({ contentId: c.contentId, kind: c.kind, durationMs: c.durationMs, teams: c.teams, events: c.events, transcript: c.transcript });
  });
  http.post("/api/utterance", async (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    if (!text) return void res.status(400).json({ error: "text required" });
    res.json(await orchestrator.handle(text, { inputSource: req.body?.inputSource ?? "text", device: req.body?.device ?? "tv" }));
  });
  http.get("/api/session", (_req, res) => {
    const s = app.sessions.get();
    res.json({ spoilerMode: s.spoilerMode, watchedUpToMs: s.watchedUpToMs, activeRef: s.activeRef, activeEntityId: s.activeEntityId, interpreter: orchestrator.interpreterName });
  });
  http.post("/api/session", (req, res) => {
    const s = app.sessions.get();
    if (req.body?.spoilerMode === "strict" || req.body?.spoilerMode === "full") s.spoilerMode = req.body.spoilerMode;
    if (typeof req.body?.watchedUpToMs === "number") s.extendBoundary(req.body.watchedUpToMs);
    res.json({ spoilerMode: s.spoilerMode, watchedUpToMs: s.watchedUpToMs });
  });
  http.get("/api/tts", async (req, res) => {
    const text = String(req.query.text ?? "").trim();
    if (!text) return void res.status(400).end();
    const t0 = Date.now();
    try {
      const voice = ALLOWED_VOICES.has(String(req.query.voice)) ? (String(req.query.voice) as typeof POLLY_VOICE) : POLLY_VOICE;
      const audio = await synthesize(text, voice);
      if (req.query.turnId)
        app.emit({ type: "trace", turnId: String(req.query.turnId), trace: { kind: "action", label: `spoken reply (${audio.length} B mp3)`, component: `amazon-polly:generative:${POLLY_VOICE}`, ms: Date.now() - t0 } });
      res.type("audio/mpeg").send(Buffer.from(audio));
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });
  http.get("/api/shares", (_req, res) => res.json(app.shares));
  http.get("/api/memory", async (_req, res) => res.json(await app.memory.recent(app.sessions.get().userId, 50)));

  const server = createServer(http);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    let deviceId = "";
    let unsubscribe: (() => void) | null = null;
    ws.on("message", async (raw) => {
      let msg: WireMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "hello") {
        deviceId = msg.deviceId;
        if (msg.role === "player") app.bridge.register(ws, deviceId, msg.deviceKind ?? "web");
        unsubscribe = app.onEmit((m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)));
        const first = app.store.get(msg.contentId) ?? app.currentIndex();
        if (msg.role === "player" && first)
          ws.send(JSON.stringify({ type: "command", id: "init", command: { cmd: "load", contentId: first.contentId, url: `/media/${first.contentId}/${first.media}` } } satisfies WireMessage));
        if (msg.role === "companion") for (const s of app.shares) ws.send(JSON.stringify({ type: "share", share: s } satisfies WireMessage));
        return;
      }
      if (msg.type === "utterance") {
        app.bridge.setActive(deviceId);
        await orchestrator.handle(msg.text, { inputSource: msg.source, device: deviceId });
        return;
      }
      if (deviceId) app.bridge.handle(deviceId, msg);
    });
    ws.on("close", () => unsubscribe?.());
  });

  await new Promise<void>((r) => server.listen(port, opts.host ?? "0.0.0.0", r));
  return { server, app, orchestrator, port, publicBaseUrl, close: () => new Promise<void>((r) => { wss.close(); server.close(() => r()); }) };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const s = await startServer();
  console.log(`Semantic Playback on http://localhost:${s.port}  (LAN: ${s.publicBaseUrl})`);
  console.log(`  TV:     ${s.publicBaseUrl}/tv/\n  Phone:  ${s.publicBaseUrl}/phone/\n  MCP:    ${s.publicBaseUrl}/mcp`);
  console.log(`  interpreter=${s.orchestrator.interpreterName} memory=${s.app.memory.backend} content=${s.app.store.list().map((c) => `${c.contentId}(${c.embeddingModel})`).join(",") || "none — run npm run ingest"}`);
}
