/**
 * Ingestion: provider feed + transcript (+ optional OCR) → unified semantic timeline → index.
 *
 * Input  data/content/<id>/provider.json, commentary.json | dialogue.json (or an Amazon Transcribe result JSON)
 *        provider.json kind "sports_match" (roster/events/replays/scoreboard) or "narrative"
 *        (characters/objects/scenes/beats/signs/presence).
 * Output data/index/<id>.json (ContentIndex: entities, event/replay/window segments with embeddings)
 *
 * This file is the local equivalent of the v2 pre-indexing flow
 * (transcript + temporal segmentation + embeddings + provider metadata → unified timeline).
 * It persists to a JSON index; DynamoDB/OpenSearch are the production targets (see v2).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  type ContentIndex,
  type Entity,
  type ProviderEvent,
  type Segment,
  type TranscriptLine,
  entityIdForPlayer,
  entityIdForTeam,
  formatMs,
} from "../../../packages/contracts/src/index.ts";
import { type Embedder, defaultEmbedder } from "./embeddings.ts";

const NUM_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"];
const ROLE_WORDS: Record<string, string[]> = {
  GK: ["goalkeeper", "keeper", "goalie"],
  ST: ["striker", "centre forward"],
  RW: ["right winger", "winger"],
  LW: ["left winger", "winger"],
  CB: ["centre back", "defender"],
  RB: ["right back", "defender"],
  LB: ["left back", "defender"],
  DM: ["defensive midfielder", "midfielder"],
  CM: ["midfielder"],
  AM: ["playmaker", "attacking midfielder"],
};

interface ProviderFeed {
  contentId: string;
  title: string;
  kind: string;
  durationMs: number;
  media: string;
  source: string;
  teams: { id: string; name: string; short: string; side: "home" | "away" }[];
  roster: { team: string; number: number; name: string; position: string }[];
  events: ProviderEvent[];
  replays: { startMs: number; endMs: number; sourceStartMs: number; sourceEndMs: number; ofEventId: string }[];
  scoreboard: { startMs: number; endMs: number; text: string; home: number; away: number }[];
  possession: { startMs: number; endMs: number; team: string; number: number; name: string }[];
  touches: { ms: number; team: string; number: number; name: string }[];
}

/** Parse an Amazon Transcribe batch result (results.items with start_time/end_time) into lines. */
export function parseTranscribeResult(json: any, maxGapMs = 700): TranscriptLine[] {
  const items: any[] = json?.results?.items ?? [];
  const lines: TranscriptLine[] = [];
  let cur: TranscriptLine | null = null;
  for (const it of items) {
    const word = it.alternatives?.[0]?.content ?? "";
    if (it.type === "punctuation") {
      if (cur) cur.text += word;
      continue;
    }
    const s = Math.round(parseFloat(it.start_time) * 1000);
    const e = Math.round(parseFloat(it.end_time) * 1000);
    if (!cur || s - cur.endMs > maxGapMs) {
      cur = { id: `tx-${lines.length + 1}`, startMs: s, endMs: e, speaker: it.speaker_label ?? "speaker", text: word };
      lines.push(cur);
    } else {
      cur.text += ` ${word}`;
      cur.endMs = e;
    }
  }
  return lines;
}

function overlap(a0: number, a1: number, b0: number, b1: number) {
  return Math.min(a1, b1) - Math.max(a0, b0) > 0;
}

export function buildEntities(feed: ProviderFeed): Entity[] {
  const ents: Entity[] = feed.teams.map((t) => ({
    id: entityIdForTeam(t.id),
    type: "team",
    name: t.name,
    aliases: [t.short, t.name.replace(/ (FC|United)$/, ""), t.side === "home" ? "home side" : "away side"],
  }));
  for (const p of feed.roster) {
    const team = feed.teams.find((t) => t.id === p.team)!;
    ents.push({
      id: entityIdForPlayer(p.team, p.number),
      type: "player",
      name: p.name,
      team: p.team,
      number: p.number,
      role: p.position,
      aliases: [
        `#${p.number} ${team.short}`,
        `number ${p.number} ${team.short}`,
        `number ${NUM_WORDS[p.number] ?? p.number} ${team.short}`,
        `${team.name.split(" ")[0]} ${ROLE_WORDS[p.position]?.[0] ?? ""}`.trim(),
        ...(ROLE_WORDS[p.position] ?? []).map((r) => `${team.short} ${r}`),
      ],
    });
  }
  return ents;
}

function eventLabel(e: ProviderEvent, events: ProviderEvent[]): string {
  const p0 = e.players[0];
  const who = p0 ? `${p0.name} (#${p0.number})` : "";
  switch (e.type) {
    case "goal":
      return `Goal ${e.goalNumber} — ${e.scorer!.name} (#${e.scorer!.number}), ${e.score!.home}-${e.score!.away}`;
    case "replay": {
      const g = events.find((x) => x.id === e.ofEventId);
      return g?.type === "goal" ? `Replay of goal ${g.goalNumber} — ${g.scorer!.name}` : `Replay — ${e.description}`;
    }
    case "save":
      return `Save — ${who} denies ${e.players[1]?.name ?? "the shot"}`;
    case "yellow_card":
      return `Yellow card — ${who}`;
    case "shot":
      return `Shot — ${who}${e.outcome ? ` (${e.outcome})` : ""}`;
    case "celebration":
      return `Celebration — ${who}`;
    case "final_whistle":
      return "Full time";
    default:
      return `${e.type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}${who ? ` — ${who}` : ""}`;
  }
}

/** How much lead-in a seek to this event should include (v2: start at the moment, not the instant). */
function leadInMs(type: string) {
  return type === "goal" ? 5000 : type === "replay" ? 0 : type === "save" || type === "shot" ? 3000 : 1500;
}

interface NarrativeFeed {
  contentId: string;
  title: string;
  kind: "narrative";
  durationMs: number;
  media: string;
  source: string;
  characters: { id: string; name: string; role: string; aliases: string[]; description: string; appearance?: string }[];
  objects: { id: string; name: string; aliases: string[] }[];
  scenes: { id: string; number: number; title: string; location: string; startMs: number; endMs: number; characters: string[]; objects: string[]; description: string }[];
  beats: { id: string; type: string; sceneId: string; startMs: number; endMs: number; description: string; characters: string[]; objects: string[] }[];
  signs: { startMs: number; endMs: number; text: string; kind?: string }[];
  presence: { startMs: number; endMs: number; characterId: string; name: string }[];
}

const characterId = (id: string) => `character:${id}`;
const objectId = (id: string) => `object:${id}`;

function loadTranscript(contentDir: string, transcribePath?: string): { transcript: TranscriptLine[]; transcriptSource: string } {
  if (transcribePath) return { transcript: parseTranscribeResult(JSON.parse(readFileSync(transcribePath, "utf8"))), transcriptSource: "amazon-transcribe" };
  const dialogue = join(contentDir, "dialogue.json");
  if (existsSync(dialogue)) return { transcript: JSON.parse(readFileSync(dialogue, "utf8")).lines, transcriptSource: "dialogue-script" };
  return { transcript: JSON.parse(readFileSync(join(contentDir, "commentary.json"), "utf8")).lines, transcriptSource: "commentary-script" };
}

/** Narrative titles: scenes + story beats + dialogue windows, grounded on characters and objects. */
async function buildNarrativeIndex(feed: NarrativeFeed, transcript: TranscriptLine[], transcriptSource: string, embedder: Embedder): Promise<ContentIndex> {
  const entities: Entity[] = [
    ...feed.characters.map((c) => ({ id: characterId(c.id), type: "character" as const, name: c.name, role: c.role, aliases: c.aliases, description: c.appearance ? `${c.description} Appearance: ${c.appearance}.` : c.description })),
    ...feed.objects.map((o) => ({ id: objectId(o.id), type: "object" as const, name: o.name, aliases: o.aliases })),
  ];
  const nameOf = (id: string) => feed.characters.find((c) => c.id === id)?.name ?? id;
  // Speaker ids in the transcript are character ids; names go into the text so lexical search finds them.
  const tx = (a: number, b: number) =>
    transcript
      .filter((l) => overlap(a, b, l.startMs, l.endMs))
      .map((l) => `${nameOf(l.speaker)}: ${l.text}`)
      .join(" ");
  const screen = (a: number, b: number) => [...new Set(feed.signs.filter((s) => overlap(a, b, s.startMs, s.endMs)).map((s) => s.text))];
  const ids = (chars: string[], objs: string[]) => [...chars.map(characterId), ...objs.map(objectId)];
  const prov: Segment["provenance"] = [
    { source: "provider-feed", confidence: 1, epistemicType: "provider_metadata", privacy: "content_metadata", spoilerScope: "safe_before_playhead" },
    { source: transcriptSource, confidence: 1, epistemicType: "observed", privacy: "content_metadata" },
  ];

  const events: ProviderEvent[] = [
    ...feed.scenes.map((sc) => ({ id: sc.id, type: "scene", startMs: sc.startMs, endMs: sc.endMs, description: sc.description, players: [], entityIds: ids(sc.characters, sc.objects), sceneId: sc.id, title: sc.title })),
    ...feed.beats.map((b) => ({ id: b.id, type: "beat", startMs: b.startMs, endMs: b.endMs, description: b.description, players: [], entityIds: ids(b.characters, b.objects), sceneId: b.sceneId, title: b.type })),
  ].sort((a, b) => a.startMs - b.startMs);

  const segments: Segment[] = [];
  for (const sc of feed.scenes) {
    const transcriptText = tx(sc.startMs, sc.endMs);
    segments.push({
      id: `seg-${sc.id}`, contentId: feed.contentId, kind: "event", startMs: sc.startMs, endMs: sc.endMs, eventId: sc.id, eventType: "scene",
      label: `Scene ${sc.number} — ${sc.title}`,
      text: [`Scene ${sc.number}: ${sc.title}`, sc.location, sc.description, `With ${sc.characters.map(nameOf).join(" and ")}`, ...screen(sc.startMs, sc.endMs), transcriptText].join(". "),
      transcript: transcriptText, entityIds: ids(sc.characters, sc.objects), screenText: screen(sc.startMs, sc.endMs), provenance: prov,
    });
  }
  for (const b of feed.beats) {
    const transcriptText = tx(b.startMs, b.endMs);
    const sc = feed.scenes.find((s) => s.id === b.sceneId);
    segments.push({
      id: `seg-${b.id}`, contentId: feed.contentId, kind: "event", startMs: b.startMs, endMs: b.endMs, eventId: b.id, eventType: "beat",
      label: b.description,
      text: [b.description, b.type, sc ? `${sc.title}, ${sc.location}` : "", b.objects.map((o) => feed.objects.find((x) => x.id === o)?.name ?? o).join(", "), transcriptText].join(". "),
      transcript: transcriptText, entityIds: ids(b.characters, b.objects), screenText: screen(b.startMs, b.endMs), provenance: prov,
    });
  }
  const WIN = 8000;
  for (let s = 0; s < feed.durationMs; s += WIN) {
    const e = Math.min(feed.durationMs, s + WIN);
    const transcriptText = tx(s, e);
    if (!transcriptText) continue;
    const here = [...new Set(feed.presence.filter((p) => overlap(s, e, p.startMs, p.endMs)).map((p) => p.characterId))];
    segments.push({
      id: `seg-win-${s}`, contentId: feed.contentId, kind: "window", startMs: s, endMs: e, label: `${formatMs(s)}–${formatMs(e)}`,
      text: [transcriptText, `On screen: ${here.map(nameOf).join(", ")}`].join(". "),
      transcript: transcriptText, entityIds: here.map(characterId), screenText: screen(s, e), provenance: prov,
    });
  }
  const vectors = await embedder.embed(segments.map((s) => s.text), "index");
  segments.forEach((s, i) => (s.embedding = vectors[i]));
  segments.sort((a, b) => a.startMs - b.startMs);
  return {
    contentId: feed.contentId, title: feed.title, kind: feed.kind, durationMs: feed.durationMs, media: feed.media,
    builtAt: new Date().toISOString(), embeddingModel: embedder.model, embeddingDim: embedder.dim,
    sources: { provider: feed.source, transcript: transcriptSource, screenText: "provider-sign-feed", embeddings: embedder.model },
    entities, events, transcript, segments, scoreboard: [], possession: [], touches: [], teams: [],
    signs: feed.signs,
    presence: feed.presence.map((p) => ({ startMs: p.startMs, endMs: p.endMs, entityId: characterId(p.characterId), name: p.name })),
  };
}

export async function buildIndex(contentDir: string, embedder: Embedder = defaultEmbedder(), transcribePath?: string) {
  const raw = JSON.parse(readFileSync(join(contentDir, "provider.json"), "utf8"));
  const { transcript, transcriptSource } = loadTranscript(contentDir, transcribePath);
  if (raw.kind === "narrative") return buildNarrativeIndex(raw as NarrativeFeed, transcript, transcriptSource, embedder);
  const feed: ProviderFeed = raw;

  const entities = buildEntities(feed);
  const tx = (a: number, b: number) =>
    transcript
      .filter((l) => overlap(a, b, l.startMs, l.endMs))
      .map((l) => l.text)
      .join(" ");
  const screen = (a: number, b: number) => [...new Set(feed.scoreboard.filter((s) => overlap(a, b, s.startMs, s.endMs)).map((s) => s.text))];
  const teamName = (id: string) => feed.teams.find((t) => t.id === id)?.name ?? id;

  const segments: Segment[] = [];
  for (const e of feed.events) {
    const isReplay = e.type === "replay";
    const start = Math.max(0, e.startMs - leadInMs(e.type));
    const end = e.endMs + (isReplay ? 0 : 1000);
    const label = eventLabel(e, feed.events);
    const playerIds = e.players.map((p) => entityIdForPlayer(p.team, p.number));
    const teamIds = [...new Set(e.players.map((p) => entityIdForTeam(p.team)))];
    const of = isReplay ? feed.events.find((x) => x.id === e.ofEventId) : undefined;
    const transcriptText = tx(start, end);
    const words = [
      label,
      e.description,
      isReplay ? `replay slow motion of ${of?.type} ${of?.description ?? ""}` : e.type.replace(/_/g, " "),
      e.players.map((p) => `${p.name} number ${p.number} ${teamName(p.team)}`).join(", "),
      transcriptText,
    ];
    segments.push({
      id: `seg-${e.id}`,
      contentId: feed.contentId,
      kind: isReplay ? "replay" : "event",
      startMs: start,
      endMs: end,
      eventId: e.id,
      eventType: e.type,
      ofEventId: e.ofEventId,
      label,
      text: words.join(". "),
      transcript: transcriptText,
      entityIds: [...playerIds, ...teamIds],
      screenText: screen(start, end),
      provenance: [
        { source: "provider-feed", confidence: 1, epistemicType: "provider_metadata", privacy: "content_metadata", spoilerScope: "safe_before_playhead" },
        { source: transcriptSource, confidence: 1, epistemicType: "observed", privacy: "content_metadata" },
      ],
    });
  }

  // Fixed windows give retrieval coverage between explicit events.
  const WIN = 8000;
  for (let s = 6000; s < feed.durationMs; s += WIN) {
    const e = Math.min(feed.durationMs, s + WIN);
    const holders = feed.possession.filter((p) => overlap(s, e, p.startMs, p.endMs));
    const ids = [...new Set(holders.map((p) => entityIdForPlayer(p.team, p.number)))];
    const transcriptText = tx(s, e);
    segments.push({
      id: `seg-win-${s}`,
      contentId: feed.contentId,
      kind: "window",
      startMs: s,
      endMs: e,
      label: `${formatMs(s)}–${formatMs(e)}`,
      text: [transcriptText, `In possession: ${[...new Set(holders.map((h) => `${h.name} #${h.number}`))].join(", ")}`].join(". "),
      transcript: transcriptText,
      entityIds: ids,
      screenText: screen(s, e),
      provenance: [
        { source: "provider-feed", confidence: 1, epistemicType: "provider_metadata", privacy: "content_metadata" },
        { source: transcriptSource, confidence: 1, epistemicType: "observed", privacy: "content_metadata" },
      ],
    });
  }

  const vectors = await embedder.embed(
    segments.map((s) => s.text),
    "index",
  );
  segments.forEach((s, i) => (s.embedding = vectors[i]));
  segments.sort((a, b) => a.startMs - b.startMs);

  const index: ContentIndex = {
    contentId: feed.contentId,
    title: feed.title,
    kind: feed.kind,
    durationMs: feed.durationMs,
    media: feed.media,
    builtAt: new Date().toISOString(),
    embeddingModel: embedder.model,
    embeddingDim: embedder.dim,
    sources: { provider: feed.source, transcript: transcriptSource, screenText: "provider-scoreboard-feed", embeddings: embedder.model },
    entities,
    events: feed.events,
    transcript,
    segments,
    scoreboard: feed.scoreboard,
    possession: feed.possession,
    touches: feed.touches,
    teams: feed.teams,
  };
  return index;
}

export async function ingest(dataDir: string, contentId: string, transcribePath?: string) {
  const index = await buildIndex(join(dataDir, "content", contentId), defaultEmbedder(), transcribePath);
  const outDir = join(dataDir, "index");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${contentId}.json`);
  writeFileSync(out, JSON.stringify(index));
  return { out, index };
}
