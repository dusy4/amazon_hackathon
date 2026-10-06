import { WebPlayer } from "./player.js";

const $ = (id) => document.getElementById(id);
const fmt = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const deviceId = `tv-web-${Math.random().toString(36).slice(2, 7)}`;
const video = $("video");
const player = new WebPlayer(video, deviceId);
let ws;
let timeline = null;
let watchedUpToMs = 0;
let spoilerMode = "strict";
let voiceReplies = true;
let currentTurn = null;

const SUGGESTIONS = {
  sports_match: [
  "Go back to the replay of the last goal",
  "Three seconds earlier",
  "Half speed",
  "Repeat it 3 times",
  "Normal speed",
  "Who is number 7?",
  "Show me his shots",
  "The second one",
  "Show every yellow card so far",
  "Go to the save before the second goal",
  "Read the score",
  "What did he just say?",
  "I was away for 2 minutes, catch me up",
  "Clip that and send it to my phone",
  "Who was the player I asked about?",
  "Back to live",
  "Rewind to the replay of the last goal, start three seconds before it, play it slower, repeat it twice, clip it, and send it to my phone",
  "Watch The Keeper's Key",
  ],
  narrative: [
    "Who is this?",
    "Read that",
    "What did she just say?",
    "Go back to the previous scene with Theo",
    "Go to the scene where Mara finds the letter",
    "Who is the inspector?",
    "Show every scene with Hale",
    "The second one",
    "I looked away, catch me up",
    "Three seconds earlier",
    "Clip the scene where Theo shows the map and send it to my phone",
    "Spoilers off",
    "Switch to the match",
  ],
};

// ------------------------------------------------------------------ websocket / player bridge
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "hello", role: "player", deviceId, deviceKind: "web", contentId: new URLSearchParams(location.search).get("content") ?? undefined }));
    setChip("chip-conn", "player bridge: connected", true);
  };
  ws.onclose = () => {
    setChip("chip-conn", "offline", false);
    setTimeout(connect, 1500);
  };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "command") {
      try {
        const state = await player.exec(msg.command);
        if (msg.command.cmd === "load") await loadTimeline(msg.command.contentId);
        ws.send(JSON.stringify({ type: "ack", id: msg.id, ok: true, state }));
      } catch (e) {
        ws.send(JSON.stringify({ type: "ack", id: msg.id, ok: false, error: String(e.message ?? e) }));
      }
    } else if (msg.type === "trace") onTrace(msg.trace, msg.turnId);
    else if (msg.type === "turn") onTurn(msg.turn);
    else if (msg.type === "state" && msg.state.deviceId !== deviceId) {
      /* another player (e.g. Fire OS) is active: mirror nothing, show chip */
      setChip("chip-conn", `player: ${msg.state.deviceKind} ${fmt(msg.state.positionMs)}`, true);
    }
  };
}
player.onChange = (state) => {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "state", state }));
  renderHud(state);
};
setInterval(() => {
  const s = player.state();
  if (ws?.readyState === 1 && !s.paused) ws.send(JSON.stringify({ type: "state", state: s }));
  if (!s.paused) watchedUpToMs = Math.max(watchedUpToMs, s.positionMs);
  renderTimeline(s);
}, 250);

function setChip(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle("ok", !!ok);
}

// ------------------------------------------------------------------ timeline
async function loadTimeline(contentId) {
  const [tl, content, health] = await Promise.all([
    fetch(`/api/timeline/${contentId}`).then((r) => r.json()),
    fetch("/api/content").then((r) => r.json()),
    fetch("/api/health").then((r) => r.json()),
  ]);
  timeline = tl;
  watchedUpToMs = 0;
  const c = content.find((x) => x.contentId === contentId);
  renderSuggestions(c?.kind);
  $("title").textContent = c ? `${c.title} · transcript: ${c.sources.transcript} · screen text: ${c.sources.screenText}` : contentId;
  setChip("chip-embed", `embeddings: ${c?.embeddingModel ?? "?"}`, true);
  setChip("chip-interp", `interpreter: ${health.interpreter}`, true);
  const track = $("track");
  track.querySelectorAll(".mark,.span").forEach((n) => n.remove());
  const pct = (ms) => `${(ms / tl.durationMs) * 100}%`;
  for (const e of tl.events) {
    if (e.type === "scene") {
      const s = document.createElement("div");
      s.className = "span scene";
      s.style.left = pct(e.startMs);
      s.style.width = pct(e.endMs - e.startMs);
      s.textContent = e.title ?? "";
      s.title = `${fmt(e.startMs)} ${e.title}: ${e.description}`;
      track.prepend(s);
    } else if (e.type === "beat") {
      const m = document.createElement("div");
      m.className = "mark beat";
      m.style.left = pct(e.startMs);
      m.textContent = "◆";
      m.title = `${fmt(e.startMs)} ${e.description}`;
      track.appendChild(m);
    } else if (e.type === "replay") {
      const s = document.createElement("div");
      s.className = "span replay";
      s.style.left = pct(e.startMs);
      s.style.width = pct(e.endMs - e.startMs);
      s.title = e.description;
      track.prepend(s);
    } else if (["goal", "yellow_card", "save", "shot"].includes(e.type)) {
      const m = document.createElement("div");
      const team = e.scorer?.team ?? e.players[0]?.team ?? "";
      m.className = `mark ${e.type} ${team}`;
      m.style.left = pct(e.startMs);
      m.textContent = e.type === "goal" ? "G" : e.type === "yellow_card" ? "Y" : e.type === "save" ? "S" : "";
      m.title = `${fmt(e.startMs)} ${e.description}`;
      track.appendChild(m);
    }
  }
}

function renderTimeline(s) {
  if (!timeline) return;
  const d = timeline.durationMs;
  $("playhead").style.left = `${(s.positionMs / d) * 100}%`;
  $("watched").style.width = `${(Math.max(watchedUpToMs, 0) / d) * 100}%`;
  const lr = $("loop-range");
  const range = s.loop ?? s.segment;
  lr.hidden = !range;
  if (range) {
    lr.style.left = `${(range.startMs / d) * 100}%`;
    lr.style.width = `${((range.endMs - range.startMs) / d) * 100}%`;
  }
  $("t-pos").textContent = fmt(s.positionMs);
  $("t-dur").textContent = fmt(d);
}

function renderHud(s) {
  $("hud-rate").textContent = s.rate !== 1 ? `${+s.rate.toFixed(2)}×` : "";
  $("hud-loop").textContent = s.loop ? `⟲ ${s.loop.remaining} left` : s.segment ? "segment" : "";
}

$("track").addEventListener("click", async (e) => {
  if (!timeline) return;
  const r = e.currentTarget.getBoundingClientRect();
  const ms = ((e.clientX - r.left) / r.width) * timeline.durationMs;
  if (ms > watchedUpToMs) fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ watchedUpToMs: ms }) });
  watchedUpToMs = Math.max(watchedUpToMs, ms);
  player.exec({ cmd: "seek", positionMs: ms });
});

// ------------------------------------------------------------------ asking
async function ask(text, source = "text") {
  text = text.trim();
  if (!text) return;
  $("q").value = "";
  ws.send(JSON.stringify({ type: "utterance", text, source }));
}
$("ask").addEventListener("submit", (e) => {
  e.preventDefault();
  ask($("q").value);
});
function renderSuggestions(kind) {
  $("suggest").replaceChildren();
  for (const s of SUGGESTIONS[kind] ?? SUGGESTIONS.sports_match) {
    const b = document.createElement("button");
    b.textContent = s;
    b.dataset.focus = "";
    b.addEventListener("click", () => ask(s, "suggestion"));
    $("suggest").appendChild(b);
  }
}
renderSuggestions("sports_match");

// Browser speech recognition (client-side STT) — labelled as such in the pipeline.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) $("mic").title = "Speech recognition not available in this browser — type instead";
$("mic").addEventListener("click", () => {
  if (!SR) return;
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = true;
  $("mic").classList.add("listening");
  rec.onresult = (e) => {
    const r = e.results[e.results.length - 1];
    $("q").value = r[0].transcript;
    if (r.isFinal) ask(r[0].transcript, "browser-speech-recognition");
  };
  rec.onend = () => $("mic").classList.remove("listening");
  rec.start();
});

// ------------------------------------------------------------------ pipeline rendering
function onTrace(step, turnId) {
  if (!currentTurn || currentTurn !== turnId) {
    currentTurn = turnId;
    $("trace").innerHTML = "";
  }
  if (step.kind === "input") $("utt").textContent = `Turn ${turnId}`;
  if (step.kind === "context") $("envelope").textContent = JSON.stringify(step.data, null, 2);
  const li = document.createElement("li");
  li.className = step.kind;
  const data = step.data !== undefined && step.kind !== "context" ? `<details><summary>payload</summary><pre class="json">${esc(JSON.stringify(step.data, null, 2))}</pre></details>` : "";
  const ctx =
    step.kind === "context"
      ? `<div class="c">Relevant Core: pos ${fmt(step.data.relevantCore.playback?.positionMs ?? 0)}, active ref “${esc(step.data.relevantCore.activeReference?.label ?? "none")}”, entities ${esc(step.data.relevantCore.currentEntities.map((e) => e.name).join(", ") || "—")}, spoiler boundary ${fmt(step.data.relevantCore.spoilerBoundaryMs)} · Ambient: ${step.data.ambient.recentActions.length} recent actions · Deep: ${esc(step.data.deep.viewingActivityRef)}</div>`
      : "";
  const fields = keyFields(step);
  li.innerHTML = `<div class="k"><span>${step.kind.replace("_", " ")}</span><span class="ms">+${step.ms}ms</span></div><div class="l">${esc(step.label)}</div><div class="c">${esc(step.component)}</div>${fields ? `<div class="f">${esc(fields)}</div>` : ""}${ctx}${data}`;
  $("trace").appendChild(li);
  const box = $("tab-pipeline");
  box.scrollTop = box.scrollHeight;
}

/** The 1–4 fields worth reading at a glance (full payload stays expandable). */
function keyFields(step) {
  const d = step.data;
  if (!d || typeof d !== "object") return "";
  if (step.kind === "tool_call") return Object.entries(d).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join("  ").slice(0, 160);
  if (step.kind === "tool_result" || step.kind === "error") {
    if (d.error) return `error: ${d.error}`;
    if (d.top) return d.top.length ? `→ ${d.top[0].label} @ ${fmt(d.top[0].startMs)} · score ${d.top[0].score} (sem ${d.top[0].breakdown.semantic}, lex ${d.top[0].breakdown.lexical}, ent ${d.top[0].breakdown.entity}, evt ${d.top[0].breakdown.event})${d.hiddenBySpoilerBoundary ? ` · ${d.hiddenBySpoilerBoundary} hidden (spoilers)` : ""}` : `→ 0 results${d.hiddenBySpoilerBoundary ? `, ${d.hiddenBySpoilerBoundary} hidden by spoiler boundary` : ""}`;
    if (d.positionMs !== undefined && d.deviceKind) return `→ ${d.deviceKind} player @ ${fmt(d.positionMs)} · ${d.rate}× · ${d.paused ? "paused" : "playing"}${d.loop ? ` · loop ×${d.loop.remaining}` : ""}`;
    if (d.entity) return `→ ${d.entity.name} #${d.entity.number} (${d.entity.team}) · ${d.provenance?.source}`;
    if (d.clipId) return `→ ${d.clipId} · ${d.renderMs}ms · ${d.renderer}`;
    if (d.deliveredTo) return `→ ${d.deliveredTo}`;
    if (d.resolutions) return `→ ${d.resolutions.map((r) => `${r.name} #${r.number ?? ""} (${r.matchedBy})`).join(", ")}`;
    if (d.summary) return `→ ${d.summary}`.slice(0, 180);
    if (d.text !== undefined) return `→ “${d.text}” ${d.clock ?? ""} · ${d.source ?? ""}`;
    if (d.results) return `→ ${d.results.length} memories · ${d.backend}`;
    if (d.lines) return `→ ${d.lines.length} lines · ${d.source}`;
  }
  return "";
}

function onTurn(turn) {
  const toast = $("toast");
  toast.hidden = false;
  toast.textContent = turn.speech;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (toast.hidden = true), 9000);
  renderCards(turn.cards);
  if (voiceReplies && "speechSynthesis" in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(turn.speech);
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }
  refreshMemory();
}

function renderCards(cards) {
  const box = $("cards");
  box.innerHTML = "";
  for (const c of cards.slice(-2)) {
    const el = document.createElement("div");
    el.className = "card";
    if (c.type === "moment") el.innerHTML = `<h4>${esc(c.title)}</h4><div class="sub">${esc(c.subtitle ?? "")}</div>`;
    else if (c.type === "moments")
      el.innerHTML = `<h4>${esc(c.title)}</h4><ul>${c.items.map((it, i) => `<li class="${i === c.selected ? "sel" : ""}">${fmt(it.startMs)} · ${esc(it.label)}</li>`).join("")}</ul>`;
    else if (c.type === "entity") el.innerHTML = `<h4>${esc(c.title)}</h4><div class="sub">${esc(c.subtitle ?? "")}</div><ul>${c.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`;
    else if (c.type === "text") el.innerHTML = `<h4>${esc(c.title)}</h4><pre>${esc(c.body)}</pre>`;
    else if (c.type === "memory") el.innerHTML = `<h4>${esc(c.title)}</h4><ul>${c.items.map((it) => `<li>${esc(it.summary)}</li>`).join("")}</ul>`;
    else if (c.type === "clip")
      el.innerHTML = `<h4>🎬 ${esc(c.title)}</h4><div class="sub">${fmt(c.clip.startMs)}–${fmt(c.clip.endMs)} · ${esc(c.clip.renderer)} · ${c.clip.renderMs}ms</div>
        <div class="clip"><img src="${esc(c.clip.thumbnailUrl)}" alt="clip thumbnail" />${c.share ? `<div><div class="qr">${c.share.qrSvg}</div><div class="sub">Sent to phone · scan to open</div></div>` : ""}</div>`;
    box.appendChild(el);
  }
  clearTimeout(box._t);
  box._t = setTimeout(() => (box.innerHTML = ""), 20000);
}

async function refreshMemory() {
  const items = await fetch("/api/memory").then((r) => r.json());
  $("memory").innerHTML = items
    .map((e) => `<li><div>${esc(e.summary)}</div><div class="t">${esc(e.type)} · ${new Date(e.wallClock).toLocaleTimeString()} · content ${e.contentTimeMs != null ? fmt(e.contentTimeMs) : "—"}</div></li>`)
    .join("");
}

// ------------------------------------------------------------------ chrome
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    for (const id of ["pipeline", "context", "memory"]) $(`tab-${id}`).hidden = id !== t.dataset.tab;
    if (t.dataset.tab === "memory") refreshMemory();
  }),
);
$("chip-spoilers").addEventListener("click", async () => {
  spoilerMode = spoilerMode === "strict" ? "full" : "strict";
  await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spoilerMode }) });
  $("chip-spoilers").textContent = `spoilers: ${spoilerMode}`;
});
$("chip-voice").addEventListener("click", () => {
  voiceReplies = !voiceReplies;
  $("chip-voice").textContent = `voice replies: ${voiceReplies ? "on" : "off"}`;
});
$("start-btn").addEventListener("click", () => {
  $("start").remove();
  const t = Number(new URLSearchParams(location.search).get("t"));
  if (t) player.exec({ cmd: "seek", positionMs: t });
  video.play();
});

// D-pad / remote: arrows move focus between focusable controls, OK = Enter, Back/Escape blurs, Space toggles play.
document.addEventListener("keydown", (e) => {
  const inInput = document.activeElement === $("q");
  if (e.key === " " && !inInput) {
    e.preventDefault();
    video.paused ? video.play() : video.pause();
    return;
  }
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) || (inInput && ["ArrowLeft", "ArrowRight"].includes(e.key))) return;
  const items = [...document.querySelectorAll("[data-focus]")].filter((el) => el.offsetParent);
  const cur = document.activeElement;
  const cr = (cur && items.includes(cur) ? cur : items[0]).getBoundingClientRect();
  const dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
  let best = null;
  let bd = Infinity;
  for (const el of items) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - (cr.left + cr.width / 2);
    const dy = r.top + r.height / 2 - (cr.top + cr.height / 2);
    if (dx * dir[0] + dy * dir[1] <= 0) continue;
    const d = Math.hypot(dx, dy) + Math.abs(dir[0] ? dy : dx) * 2;
    if (d < bd) (bd = d), (best = el);
  }
  if (best) {
    e.preventDefault();
    best.focus();
  }
});

connect();
