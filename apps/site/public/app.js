// Semantic Playback site: interactive demo, match index, architecture explorer.
// Every trace shown here comes from /data/demo.json, exported from the recordings used in the film
// (scripts/site/build-data.py).

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [p, val] of Object.entries(v)) p.startsWith("--") ? el.style.setProperty(p, val) : (el.style[p] = val);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};
const icon = (id, cls = "ic") => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", cls);
  s.innerHTML = `<use href="#i-${id}"/>`;
  return s;
};
const fmtMs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms).toLocaleString("en-US").replace(/,/g, " ")} ms`);
const fmtClock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms / 1000) % 60)).padStart(2, "0")}`;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rowIcon(title) {
  const t = title.toLowerCase();
  if (t.includes("context")) return "layers";
  if (t.includes("router")) return "fork";
  if (t.includes("llm")) return "spark";
  if (t.includes("rekognition")) return "eye";
  if (t.includes("polly")) return "speaker";
  if (t.includes("dynamodb") || t.includes("memory")) return "db";
  if (t.includes("ivs")) return "live";
  if (t.includes("exoplayer")) return "play";
  if (t.includes("ffmpeg")) return "film";
  if (t.includes("phone")) return "phone";
  if (t.includes("spoiler")) return "shield";
  if (t.includes("translate")) return "translate";
  if (t.includes("captions")) return "cc";
  if (t.includes("relative")) return "replay";
  if (t.includes("search") || t.includes("index") || t.includes("refine")) return "search";
  return "tool";
}

// ---------------------------------------------------------------- catalogue
const TABS = [
  { id: "sports", label: "Sports", icon: "play", clips: ["lens", "goal", "slowmo", "share", "spoilers", "refine", "catchup"] },
  { id: "live", label: "Live", icon: "live", clips: ["live"] },
  { id: "films", label: "Films", icon: "film", clips: ["films", "ask", "translate"] },
  { id: "access", label: "Accessibility", icon: "cc", clips: ["access"] },
];
const CHIP_LABEL = { spoilers: "Show me Robbie Keane's goal → “spoilers off”" };

const FEATURES = [
  { clip: "spoilers", icon: "shield", c: "var(--server)", title: "It doesn't spoil", text: "Ask for a goal you haven't reached and it refuses until you say “spoilers off”. The boundary moves only with real playback.", tags: ["spoiler guard", "rules"] },
  { clip: "refine", icon: "search", c: "var(--server)", title: "It takes corrections", text: "“No, not that one, the one before half-time” narrows the last search instead of starting over. 0.6 s, no model.", tags: ["multi-turn", "hybrid index"] },
  { clip: "catchup", icon: "clock", c: "var(--server)", title: "It catches you up", text: "“I was away for 2 minutes” summarises only what you missed, and never past where you've watched.", tags: ["moments.summarize"] },
  { clip: "live", icon: "live", c: "var(--aws)", title: "It hears the stream say “goal”", text: "On an Amazon IVS live channel, goal markers ride inside the stream. The TV offers the replay and takes you back to live.", tags: ["Amazon IVS", "timed metadata"] },
  { clip: "films", icon: "eye", c: "var(--aws)", title: "It knows who's in the film", text: "“Who is she?” works for characters, not only celebrities, using a Rekognition face collection built for each film.", tags: ["Rekognition", "face collection"] },
  { clip: "translate", icon: "translate", c: "var(--violet)", title: "It reads and translates", text: "“Translate that into Spanish” reads the text on the paused frame, completes it from captions and translates it.", tags: ["DetectText", "translation"] },
];

let DATA = null;

// ---------------------------------------------------------------- hero
async function hero() {
  const v = $("#heroVideo"), bubble = $("#heroBubble"), steps = $("#heroSteps"), remote = $(".remote");
  const order = ["lens", "goal", "slowmo", "share"];
  let i = 0;
  const show = async () => {
    const clip = order[i % order.length];
    const turn = DATA.demos[clip][0];
    v.src = `/media/${clip}.mp4`;
    v.poster = `/media/${clip}.jpg`;
    bubble.classList.remove("on");
    steps.replaceChildren();
    try { await v.play(); } catch { /* autoplay blocked: poster stays */ }
    await sleep(600);
    $("span", bubble).textContent = `“${turn.said}”`;
    bubble.classList.add("on");
    remote?.classList.add("listening");
    const picked = turn.rows.filter((r) => !/Context Envelope|AgentCore/.test(r.title)).slice(0, 4);
    for (const r of picked) {
      await sleep(reduced ? 0 : 420);
      const name = r.title.startsWith("Our server") ? r.title.split(" · ")[1] : r.title.replace(/ · .*/, "");
      const li = h("li", {}, h("i", { style: { background: `var(--${r.kind})` } }), name, r.took ? h("b", {}, r.took) : null);
      steps.append(li);
      requestAnimationFrame(() => li.classList.add("on"));
    }
    remote?.classList.remove("listening");
  };
  v.addEventListener("ended", () => { i++; show(); });
  show();
}

// ---------------------------------------------------------------- match index timeline
const TYPE_GROUP = {
  goal: ["Goals", "var(--aws)"],
  chance: ["Chances, shots, saves", "var(--server)"], shot: ["Chances, shots, saves", "var(--server)"], save: ["Chances, shots, saves", "var(--server)"], free_kick: ["Chances, shots, saves", "var(--server)"], build_up: ["Chances, shots, saves", "var(--server)"],
  celebration: ["Celebrations", "var(--tv)"], award: ["Celebrations", "var(--tv)"], result: ["Celebrations", "var(--tv)"],
  talk: ["Talk and studio", "hsl(214 14% 52%)"], dialogue: ["Talk and studio", "hsl(214 14% 52%)"], establishing: ["Talk and studio", "hsl(214 14% 52%)"], advertisement: ["Talk and studio", "hsl(214 14% 52%)"],
};
const groupOf = (t) => TYPE_GROUP[t] ?? ["Play", "var(--violet)"];

function timeline() {
  const { moments, durationMs } = DATA.match;
  const tl = $("#timeline"), detail = $("#idxDetail"), legend = $("#idxLegend");
  const seen = new Map();
  for (const m of moments) { const [g, c] = groupOf(m.type); seen.set(g, c); }
  legend.replaceChildren(...[...seen].map(([g, c]) => h("span", {}, h("i", { style: { background: c } }), g)));
  const ticks = moments.map((m) => {
    const [, c] = groupOf(m.type);
    const heightPct = m.type === "goal" ? 78 : /chance|shot|save|free_kick|build_up/.test(m.type) ? 58 : m.type === "celebration" ? 46 : 30;
    const b = h("button", {
      class: "tick", role: "listitem", "aria-label": `${fmtClock(m.atMs)} ${m.label}`,
      style: { "--x": `${(m.atMs / durationMs) * 100}%`, "--w": `${Math.min(0.8, Math.max(0.35, ((m.endMs - m.atMs) / durationMs) * 100))}%`, "--h": `${heightPct}%`, "--c": c },
    });
    b.addEventListener("click", () => pick(m, b));
    b.addEventListener("mouseenter", () => matchMedia("(hover: hover)").matches && pick(m, b, true));
    tl.append(b);
    return { m, b };
  });
  function pick(m, b, soft = false) {
    if (!soft) ticks.forEach((t) => t.b.classList.toggle("sel", t.b === b));
    const [g, c] = groupOf(m.type);
    detail.replaceChildren(
      h("div", { class: "meta" }, h("span", { class: "tag", style: { "--c": c } }, g.split(",")[0]), `${fmtClock(m.atMs)} – ${fmtClock(m.endMs)}`),
      h("b", {}, m.label),
      h("p", {}, m.description),
    );
  }
  const STOP = new Set(["the", "a", "an", "me", "show", "his", "her", "goal's", "of", "to", "in", "play", "find", "go", "back", "where", "when", "that"]);
  $("#idxSearch").addEventListener("input", (e) => {
    const words = e.target.value.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w && !STOP.has(w));
    tl.classList.toggle("searching", words.length > 0);
    let first = null, n = 0;
    for (const t of ticks) {
      const hay = `${t.m.label} ${t.m.description} ${t.m.type}`.toLowerCase();
      const hit = words.length > 0 && words.every((w) => hay.includes(w.replace(/s$/, "")));
      t.b.classList.toggle("hit", hit);
      if (hit) { n++; first ??= t; }
    }
    if (first) pick(first.m, first.b);
    else if (words.length) detail.replaceChildren(h("span", { class: "muted" }, "No moment matches those words. The real search also uses meaning and people, not only words."));
    if (n > 1) detail.prepend(h("div", { class: "meta" }, `${n} moments match · showing the first`));
  });
  const bolt = ticks.find((t) => /Bolt scores first/.test(t.m.label));
  if (bolt) pick(bolt.m, bolt.b);
}

// ---------------------------------------------------------------- interactive demo
const demo = { tab: "sports", clip: "lens", run: 0, muted: true };

function demoUI() {
  const tabs = $("#demoTabs");
  for (const t of TABS) {
    tabs.append(h("button", { role: "tab", "aria-selected": String(t.id === demo.tab), onclick: () => { demo.tab = t.id; renderTabs(); select(t.clips[0]); } }, icon(t.icon), t.label));
  }
  const v = $("#demoVideo"), btn = $("#soundBtn");
  btn.addEventListener("click", () => {
    demo.muted = !demo.muted;
    v.muted = demo.muted;
    btn.replaceChildren(icon(demo.muted ? "mute" : "sound"), h("span", {}, demo.muted ? "Sound off" : "Sound on"));
    btn.setAttribute("aria-label", demo.muted ? "Turn sound on" : "Turn sound off");
  });
  $("#replayBtn").addEventListener("click", () => select(demo.clip));
  renderTabs();
  select("lens", false);
}

function renderTabs() {
  $$("#demoTabs button").forEach((b, i) => b.setAttribute("aria-selected", String(TABS[i].id === demo.tab)));
  const chips = $("#demoChips");
  chips.replaceChildren(...TABS.find((t) => t.id === demo.tab).clips.map((clip) =>
    h("button", { class: "chip", "aria-pressed": String(clip === demo.clip), onclick: () => select(clip) }, icon("mic"), CHIP_LABEL[clip] ?? `“${DATA.demos[clip][0].said}”`)));
}

async function select(clip, autoplay = true) {
  demo.clip = clip;
  const tab = TABS.find((t) => t.clips.includes(clip));
  if (tab && tab.id !== demo.tab) { demo.tab = tab.id; }
  renderTabs();
  const run = ++demo.run;
  const v = $("#demoVideo");
  v.src = `/media/${clip}.mp4`;
  v.poster = `/media/${clip}.jpg`;
  v.muted = demo.muted;
  const rows = $("#traceRows"), caps = $("#demoCaptions"), clock = $("#traceClock"), route = $("#traceRoute");
  rows.replaceChildren(); caps.replaceChildren(); route.replaceChildren(); clock.textContent = "0 ms";
  if (!autoplay) {
    const t = DATA.demos[clip][0];
    renderRoute(t);
    t.rows.forEach((r) => rows.append(rowEl(r, true)));
    clock.textContent = fmtMs(t.totalMs);
    caps.append(capEl("you", t.said, true), capEl("tv", t.answer, true));
    return;
  }
  try { await v.play(); } catch { v.muted = true; demo.muted = true; try { await v.play(); } catch {} }
  for (const [k, t] of DATA.demos[clip].entries()) {
    if (run !== demo.run) return;
    if (k > 0) { await sleep(1800); rows.append(h("li", { class: "row gap on" }, "next request")); }
    await playTurn(t, run);
  }
}

function renderRoute(t) {
  const route = $("#traceRoute");
  route.replaceChildren(
    t.interpreter === "llm" ? h("span", { class: "pill pill-llm" }, icon("spark"), "Agent lane · LLM") : h("span", { class: "pill pill-server" }, icon("fork"), "Instant lane · no AI model"),
    h("span", { class: "pill pill-time" }, `total ${fmtMs(t.totalMs)}`),
  );
}

function rowEl(r, on = false) {
  return h("li", { class: `row k-${r.kind}${on ? " on" : ""}` },
    h("span", { class: "row-ic" }, icon(rowIcon(r.title))),
    h("div", {}, h("div", { class: "row-t" }, r.title), h("div", { class: "row-d" }, r.detail)),
    h("span", { class: "row-ms" }, r.took || ""));
}
function capEl(who, text, on = false) {
  return h("div", { class: `cap${on ? " on" : ""}` }, h("span", { class: `cap-who cap-${who}` }, who === "you" ? "YOU" : "FIRE TV"), h("span", {}, text));
}

async function playTurn(t, run) {
  const rows = $("#traceRows"), caps = $("#demoCaptions"), clock = $("#traceClock");
  renderRoute(t);
  caps.replaceChildren(capEl("you", t.said));
  requestAnimationFrame(() => caps.firstChild?.classList.add("on"));
  // Replay the recorded timing. Long model waits are compressed and labelled with their real length.
  let shown = 0, wall = 0;
  const start = performance.now();
  const tick = () => { if (run === demo.run) { clock.textContent = fmtMs(Math.min(t.totalMs, shown + (performance.now() - start - wall) * 1)); } };
  const timer = setInterval(tick, 50);
  for (const r of t.rows) {
    if (run !== demo.run) { clearInterval(timer); return; }
    const gap = r.ms - shown;
    if (gap > 1500) {
      rows.append(h("li", { class: "row gap on" }, `${(gap / 1000).toFixed(1)} s ${t.interpreter === "llm" ? "AI model wait" : "wait"}, shortened here`));
      await sleep(reduced ? 0 : 700);
      wall = performance.now() - start - r.ms;
    } else {
      await sleep(reduced ? 0 : Math.max(120, gap));
    }
    shown = r.ms;
    const el = rowEl(r);
    rows.append(el);
    requestAnimationFrame(() => el.classList.add("on"));
  }
  clearInterval(timer);
  clock.textContent = fmtMs(t.totalMs);
  const cap = capEl("tv", t.answer);
  caps.append(cap);
  requestAnimationFrame(() => cap.classList.add("on"));
}

// ---------------------------------------------------------------- features
function features() {
  const grid = $("#features-grid");
  for (const f of FEATURES) {
    const t = DATA.demos[f.clip].at(-1);
    const vid = h("video", { muted: true, playsinline: true, loop: true, preload: "none" });
    vid.muted = true;
    const card = h("button", { class: "feat reveal", "aria-label": `${f.title}. Open in the demo` },
      h("div", { class: "feat-media" }, h("img", { src: `/media/${f.clip}.jpg`, alt: "", loading: "lazy" }), vid,
        h("span", { class: "feat-said" }, icon("mic"), `“${t.said}”`)),
      h("div", { class: "feat-body", style: { "--c": f.c } }, h("h3", {}, icon(f.icon), f.title), h("p", {}, f.text),
        h("div", { class: "feat-foot" }, f.tags.map((x) => h("span", { class: "tagp" }, x)))));
    card.addEventListener("mouseenter", () => { if (!matchMedia("(hover: hover)").matches) return; if (!vid.src) vid.src = `/media/${f.clip}.mp4`; vid.play().then(() => card.classList.add("playing")).catch(() => {}); });
    card.addEventListener("mouseleave", () => { vid.pause(); card.classList.remove("playing"); });
    card.addEventListener("click", () => { $("#try").scrollIntoView({ behavior: reduced ? "auto" : "smooth" }); select(f.clip); });
    grid.append(card);
  }
}

// ---------------------------------------------------------------- architecture explorer
const NODES = {
  you: { x: 20, y: 150, t: "You ask", s: "remote · app · phone", ic: "mic", c: "var(--aws)", k: "Input",
    p: "Requests come from the Fire OS app (D-pad suggestions or typed), the companion phone page or any MCP client. In the recordings a script sends them through the same endpoint.",
    li: ["One endpoint: <code>/api/utterance</code>", "Alexa+ would call the MCP server directly"] },
  ctx: { x: 195, y: 150, t: "Context Envelope", s: "what you mean", ic: "layers", c: "var(--server)", k: "Our server",
    p: "Before anything is decided, the server assembles what the request needs: the title, the playhead, who “he” or “she” is, the spoiler boundary and recent memory.",
    li: ["Relevant Core inlined: position, active reference, spoiler limit", "Ambient summarised: Viewing Memory, accessibility, devices", "Deep context passed as references only"] },
  router: { x: 370, y: 150, t: "Router", s: "cheapest exact path", ic: "fork", c: "var(--server)", k: "Our server",
    p: "Direct requests run on rules and hybrid search without any model. Open-ended ones go to the agent with a hard deadline; a late answer is never executed.",
    li: ["Rules path: 27 ms median, 77% of the golden set", "Agent path: 91% of the golden set"] },
  rules: { x: 545, y: 70, t: "Rules + hybrid search", s: "no AI model call", ic: "search", c: "var(--server)", k: "Our server",
    p: "BM25, embeddings and people channels fused with reciprocal rank fusion. Time order and spoiler limits are enforced in code, and goals start on the build-up.",
    li: ["“his goal” → 1.0 s end to end", "“not that one” narrows the last search"] },
  agent: { x: 545, y: 230, t: "LLM agent", s: "picks MCP tools", ic: "spark", c: "var(--llm)", k: "Agent",
    p: "The agent sees the Context Envelope and the tool list, and chooses tools and arguments. Our server executes them deterministically.",
    li: ["Target: Amazon Bedrock Converse, Nova 2 Lite", "Ran on OpenRouter Nemotron 120B while Bedrock was blocked, labelled everywhere"] },
  mcp: { x: 720, y: 150, t: "MCP tool server", s: "26 tools · 2025-11-25", ic: "tool", c: "var(--aws)", k: "Self-hosted MCP",
    p: "Streamable HTTP, spec 2025-11-25. The surface an Alexa+ add-on connects to; our own agent is an MCP client of it too.",
    li: ["<code>player.*</code> seek, play, speed, segment, loop", "<code>moments.*</code> <code>entities.*</code> <code>lens.*</code> <code>memory.search</code>", "<code>clip.create</code> <code>share.send</code> <code>live.*</code>"] },
  tv: { x: 895, y: 100, t: "Fire OS app", s: "Media3 ExoPlayer", ic: "tv", c: "var(--tv)", k: "Fire TV",
    p: "A native Kotlin app. It joins the player bridge over WebSocket and executes every command natively, reads IVS timed metadata and follows the Captions and Audio Description settings.",
    li: ["Freezes the frame for “who's this?”", "Shows the request, answer, tools and latency"] },
  phone: { x: 895, y: 200, t: "Companion page", s: "clips you send", ic: "phone", c: "var(--tv)", k: "Phone",
    p: "“Clip that and send it to my phone” cuts the clip with ffmpeg and pushes it to the companion page over WebSocket.",
    li: ["13 s clip from the build-up", "“Watch full match” jumps back in"] },
  rek: { x: 25, y: 330, t: "Rekognition", s: "faces · text · shots", ic: "eye", c: "var(--aws)", k: "AWS",
    p: "Shot detection at ingest, and celebrities, faces, labels and on-screen text per keyframe and live on the paused frame. Each film gets its own face collection, so characters are named too.",
    li: ["RecognizeCelebrities on the paused frame", "SearchFacesByImage for film characters", "DetectText for scores and signs"] },
  polly: { x: 200, y: 330, t: "Polly", s: "every spoken answer", ic: "speaker", c: "var(--aws)", k: "AWS",
    p: "Every answer is spoken with Amazon Polly's generative voices on the TV.", li: ["About 15 KB of audio per sentence"] },
  ivs: { x: 375, y: 330, t: "IVS", s: "live + timed metadata", ic: "live", c: "var(--aws)", k: "AWS",
    p: "A low-latency live channel. PutMetadata goal markers travel inside the stream, so the TV knows a goal happened without polling anything.",
    li: ["Cue reached the TV in about 10 s", "“Back to live” rejoins the edge"] },
  ddb: { x: 550, y: 330, t: "DynamoDB", s: "Viewing Memory", ic: "db", c: "var(--aws)", k: "AWS",
    p: "The canonical log of what you asked and watched, read into the Context Envelope with a tight latency budget.",
    li: ["“Who was the player I asked about?”"] },
  agentcore: { x: 725, y: 330, t: "AgentCore Memory", s: "agent session memory", ic: "layers", c: "var(--aws)", k: "AWS",
    p: "Every action is mirrored to Amazon Bedrock AgentCore Memory as a short-term event and read back by <code>memory.search</code>.", li: ["CreateEvent and ListEvents"] },
  s3: { x: 900, y: 330, t: "S3", s: "media for analysis", ic: "db", c: "var(--aws)", k: "AWS",
    p: "Media is staged in Amazon S3 for Rekognition Video at ingest.", li: ["Then shots, keyframes, faces, text"] },
};
const EDGES = [["you", "ctx"], ["ctx", "router"], ["router", "rules"], ["router", "agent"], ["rules", "mcp"], ["agent", "mcp"], ["mcp", "tv"], ["mcp", "phone"]];

function arch() {
  const W = 1060, H = 400, NW = 145, NH = 54;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const cx = (n) => n.x + NW / 2, cy = (n) => n.y + NH / 2;
  let paths = "";
  for (const [a, b] of EDGES) {
    const A = NODES[a], B = NODES[b];
    const x1 = A.x + NW, y1 = cy(A), x2 = B.x, y2 = cy(B), mx = (x1 + x2) / 2;
    paths += `<path class="edge flow" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"/>`;
  }
  // MCP to the AWS row
  const busY = 300;
  paths += `<path class="edge" d="M${cx(NODES.mcp)} ${NODES.mcp.y + NH} V${busY} M${cx(NODES.rek)} ${busY} H${cx(NODES.s3)}"/>`;
  for (const k of ["rek", "polly", "ivs", "ddb", "agentcore", "s3"]) paths += `<path class="edge" d="M${cx(NODES[k])} ${busY} V${NODES[k].y}"/>`;
  svg.innerHTML = `${paths}<text x="20" y="${busY - 8}" fill="var(--text-3)" font-size="11" font-family="Geist Mono, monospace">AWS SERVICES CALLED BY THE TOOLS</text>`;
  for (const [id, n] of Object.entries(NODES)) {
    const g = document.createElementNS(ns, "g");
    g.setAttribute("class", "node");
    g.setAttribute("tabindex", "0");
    g.setAttribute("role", "button");
    g.setAttribute("aria-label", n.t);
    g.style.setProperty("--nc", n.c);
    g.innerHTML = `<rect class="box" x="${n.x}" y="${n.y}" width="${NW}" height="${NH}" rx="12"/>
      <circle class="ring" cx="${n.x + 22}" cy="${n.y + NH / 2}" r="13"/>
      <svg x="${n.x + 13}" y="${n.y + NH / 2 - 9}" width="18" height="18" viewBox="0 0 24 24" class="nic"><use href="#i-${n.ic}"/></svg>
      <text class="t" x="${n.x + 42}" y="${n.y + 24}">${n.t}</text>
      <text class="s" x="${n.x + 42}" y="${n.y + 40}">${n.s}</text>`;
    const go = () => pickNode(id);
    g.addEventListener("click", go);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    svg.append(g);
  }
  $("#arch").append(svg);
  pickNode("mcp");
}
function pickNode(id) {
  const n = NODES[id];
  $$("#arch .node").forEach((g) => g.classList.toggle("sel", g.getAttribute("aria-label") === n.t));
  const p = $("#archPanel");
  p.style.setProperty("--nc", n.c);
  p.innerHTML = `<p class="kicker">${n.k}</p><h3>${n.t}</h3><p>${n.p}</p><ul>${n.li.map((x) => `<li><svg class="ic"><use href="#i-check"/></svg><span>${x}</span></li>`).join("")}</ul>`;
}

// ---------------------------------------------------------------- honest stack
const STACK = [
  ["eye", "Amazon Rekognition", "live", "Shots, faces, on-screen text, celebrities and per-film face collections, at ingest and live."],
  ["speaker", "Amazon Polly", "live", "Generative voices speak every answer on the TV."],
  ["live", "Amazon IVS", "live", "Low-latency channel with PutMetadata goal markers read by the app."],
  ["db", "Amazon DynamoDB", "live", "Viewing Memory, with a local failover when credentials expire."],
  ["layers", "Bedrock AgentCore Memory", "live", "Every action mirrored as a short-term event, read back by memory.search."],
  ["db", "Amazon S3", "live", "Media staged for Rekognition Video at ingest."],
  ["spark", "Amazon Bedrock", "blocked", "Integrated as the agent's model. Account limits stayed at zero, so the same code ran on OpenRouter."],
  ["translate", "Amazon Translate", "blocked", "Integrated and tried first. Blocked by account verification; the agent's model translates and says so."],
  ["cc", "Amazon Transcribe", "blocked", "Integrated for dialogue. Blocked by account verification; captions come from the source."],
];
function stack() {
  $("#stackGrid").append(...STACK.map(([ic, name, st, text]) =>
    h("div", { class: `svc reveal ${st === "blocked" ? "blocked" : ""}` }, h("span", { class: "svc-ic" }, icon(ic)),
      h("div", {}, h("h3", {}, name, h("span", { class: `st st-${st}` }, st === "live" ? "LIVE" : "BLOCKED ON OUR ACCOUNT")), h("p", {}, text)))));
}

// ---------------------------------------------------------------- small bits
function film() {
  const dlg = $("#film"), v = $("#filmVideo");
  $$("[data-film]").forEach((b) => b.addEventListener("click", () => {
    if (!v.src) v.src = "/media/film.mp4";
    dlg.showModal();
    v.play().catch(() => {});
  }));
  dlg.addEventListener("close", () => v.pause());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
}
function a11y() {
  const tv = $("#a11yTv");
  $$("[data-a11y]").forEach((b) => b.addEventListener("click", () => {
    tv.dataset.state = b.dataset.a11y;
    $$("[data-a11y]").forEach((x) => x.classList.toggle("on", x === b));
  }));
}
function reveal() {
  const els = $$(".section-head, .compare-card, .index-card, .loop li, .lane, .contribs li, .numbers > div, .ingest, .reveal");
  els.forEach((e) => e.classList.add("reveal"));
  if (!("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
  const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } }), { rootMargin: "0px 0px -60px 0px" });
  els.forEach((e) => io.observe(e));
}
// Start the demo the first time it scrolls into view.
function autoDemo() {
  if (!("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver(([en]) => { if (en.isIntersecting && demo.run === 0) { io.disconnect(); select(demo.clip); } }, { threshold: 0.4 });
  io.observe($("#demoVideo"));
}

(async () => {
  film(); a11y();
  DATA = await (await fetch("/data/demo.json")).json();
  hero(); timeline(); demoUI(); features(); arch(); stack(); reveal(); autoDemo();
})();
