/**
 * Deterministic intent parser ("rules" interpreter).
 *
 * Splits a multi-step utterance into clauses and maps each clause to a structured intent.
 * Reference resolution ("that goal", "his", "the second one") happens in the orchestrator,
 * which has the session state; this module is pure and fully unit-tested.
 */
import { NUMBER_WORDS } from "./entities.ts";

export type Ordinal = number | "last" | "next" | "previous";

export interface MomentSpec {
  eventTypes: string[];
  replay: boolean;
  ordinal?: Ordinal;
  /** "that goal" / "the goal" — prefer the active grounded moment if it matches. */
  deictic: boolean;
  plural: boolean;
  pronoun: boolean;
  /** Text that may contain entity mentions (names, numbers, roles, teams). */
  mentionText: string;
  /** Free-text description for hybrid retrieval. */
  query: string;
  anchor?: { relation: "before" | "after"; spec: MomentSpec };
  /** Extra descriptive words beyond the event keyword (e.g. "hit the post"). */
  descriptive: boolean;
}

export type Intent =
  | { type: "seek_moment"; spec: MomentSpec }
  | { type: "list_moments"; spec: MomentSpec }
  | { type: "select_result"; which: number | "next" | "previous" | "last" }
  | { type: "relative_seek"; deltaMs: number; base: "grounded" | "position" }
  | { type: "set_speed"; rate: number | "slower" | "faster" }
  | { type: "loop"; count: number }
  | { type: "again" }
  | { type: "clear_loop" }
  | { type: "pause" }
  | { type: "play" }
  | { type: "return_live" }
  | { type: "identify"; target: "ball_carrier" | "mention" | "pronoun" | "scorer"; mention?: string }
  | { type: "read_text" }
  | { type: "what_said" }
  | { type: "describe" }
  | { type: "catch_up"; windowMs: number }
  | { type: "clip"; spec?: MomentSpec; share: boolean }
  | { type: "share" }
  | { type: "memory_query"; text: string; types: string[] }
  | { type: "spoilers"; mode: "strict" | "full" }
  | { type: "open_content"; query: string }
  | { type: "unknown"; text: string };

const ORDINALS: Record<string, number> = { first: 1, "1st": 1, opening: 1, opener: 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5 };

const EVENT_PATTERNS: [RegExp, string[]][] = [
  [/\byellow cards?\b|\bbookings?\b|\bbooked\b|\bcards?\b/, ["yellow_card"]],
  [/\bfree[- ]kicks?\b/, ["free_kick"]],
  [/\bgoal[- ]kicks?\b/, ["goal_kick"]],
  [/\bkick[- ]?offs?\b|\brestarts?\b/, ["kickoff"]],
  [/\bsaves?\b|\bsaved\b|\bstops?\b/, ["save"]],
  [/\bheaders?\b|\bheaded\b/, ["header", "goal"]],
  [/\bhits? the (post|woodwork|bar)\b|\boff the post\b|\bthe post\b/, ["shot"]],
  [/\bshots?\b|\bshoots?\b|\bshooting\b|\bchances?\b|\battempts?\b/, ["shot", "goal"]],
  [/\bfouls?\b|\bfouled\b|\bbrought down\b/, ["foul"]],
  [/\bcorners?\b/, ["corner"]],
  [/\bcelebrat\w*/, ["celebration"]],
  [/\bfinal whistle\b|\bfull[- ]time\b|\bend of the (match|game)\b/, ["final_whistle"]],
  [/\btackles?\b|\bwins? (it|the ball) back\b/, ["tackle"]],
  [/\binterceptions?\b|\bintercepts?\b/, ["interception"]],
  [/\bclearances?\b/, ["clearance"]],
  [/\bgoals?\b|\bscored\b|\bequali[sz](er|ed|ing)\b|\blevell?ed (it|the score|things up)\b|\bopener\b|\bwinner\b|\bwinning goal\b/, ["goal"]],
  [/\bscenes?\b/, ["scene"]],
];
const PLURAL_RE = /\b(goals|saves|shots|chances|cards|bookings|fouls|corners|headers|replays|tackles|moments|attempts|scenes)\b/;

export function normalize(text: string): string {
  let t = ` ${text.toLowerCase()} `
    .replace(/[“”"]/g, "")
    .replace(/’/g, "'")
    .replace(/\ba couple of\b/g, "2")
    .replace(/\ba few\b/g, "3")
    .replace(/\btwice\b/g, "2 times")
    .replace(/\bthrice\b/g, "3 times");
  for (const [w, n] of Object.entries(NUMBER_WORDS)) {
    // "one" is also a pronoun ("the second one", "the one before that"): only convert it as a quantity.
    const re = w === "one" ? /\bone\b(?=\s*(seconds?|secs?|minutes?|mins?|times?|x)\b)|(?<=number )one\b/g : new RegExp(`\\b${w}\\b`, "g");
    t = t.replace(re, String(n));
  }
  return t.replace(/\s+/g, " ").trim();
}

const VERB_AFTER_AND =
  "(?:play|start|repeat|loop|clip|send|share|slow|pause|go|show|rewind|jump|make|save|read|tell|who|what|half|put|let|then|take|skip|stop|resume)";

export function splitClauses(utterance: string): string[] {
  return utterance
    .replace(/^\s*(hey\s+)?alexa[,\s]+/i, "")
    .split(new RegExp(`\\s*(?:,|;|!|\\?|\\.(?=\\s|$))\\s*|\\s+(?:and then|then|and)\\s+(?=${VERB_AFTER_AND}\\b)`, "i"))
    .map((c) => c.trim().replace(/^(and|then|also|and then|ok|okay|now|please)\s+/i, "").replace(/\s+please$/i, "").trim())
    .filter((c) => c.length > 0 && !/^(ok|okay|alright|right|um|uh|thanks|thank you|alexa)$/i.test(c));
}

export function parseMomentSpec(clause: string): MomentSpec | null {
  let t = normalize(clause);
  let anchor: MomentSpec["anchor"];
  const am = t.match(/^(.*?)\s+(before|after|since)\s+((?:the|that|his|her|their)\b.*)$/);
  if (am) {
    const anchorSpec = parseMomentSpec(am[3]);
    if (anchorSpec && anchorSpec.eventTypes.length) {
      anchor = { relation: am[2] === "before" ? "before" : "after", spec: anchorSpec };
      t = am[1];
    }
  }
  const replay = /\breplays?\b|\bslow[- ]?mo(tion)?\b/.test(t);
  let rest = t.replace(/\breplays?\b|\bslow[- ]?mo(tion)?\b/g, " ");
  const eventTypes: string[] = [];
  for (const [re, types] of EVENT_PATTERNS) {
    if (re.test(rest)) {
      for (const ty of types) if (!eventTypes.includes(ty)) eventTypes.push(ty);
      rest = rest.replace(re, " ");
    }
  }
  if (!replay && !eventTypes.length && !/\b(scene|moment|when|where|bit|part|time)\b/.test(t)) return null;

  let ordinal: Ordinal | undefined;
  for (const [w, n] of Object.entries(ORDINALS)) if (new RegExp(`\\b${w}\\b`).test(t)) ordinal = n;
  const sceneNo = t.match(/\bscene (?:number )?(\d+)\b/);
  if (sceneNo) ordinal = parseInt(sceneNo[1], 10);
  if (/\bwinner\b|\bwinning goal\b/.test(t)) ordinal = "last";
  if (ordinal === undefined) {
    if (/\b(last|latest|most recent|previous|earlier)\b/.test(t)) ordinal = /\bprevious\b/.test(t) ? "previous" : "last";
    else if (/\bnext\b/.test(t)) ordinal = "next";
  }
  const deictic = /\b(that|this|the)\b/.test(t) && ordinal === undefined;
  const plural = PLURAL_RE.test(t) || /\b(every|all|each)\b/.test(t);
  const pronoun = /\b(his|him|he|her|she|their|they)\b/.test(t);
  const descriptive =
    /\b(post|woodwork|bar|wide|header|cross|corner flag|slides?|late|long|low|top corner|bottom corner|volley|curl\w*)\b/.test(t) ||
    /\b(where|when|in which)\b/.test(t);
  // "the scene where Mara finds the key": story beats are more precise than whole scenes.
  if (descriptive && eventTypes.includes("scene")) eventTypes.push("beat");
  return { eventTypes, replay, ordinal, deictic, plural, pronoun, mentionText: t, query: t, anchor, descriptive };
}

function relSeek(t: string): Intent | null {
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\s+(earlier|before|back|backwards?|later|after|forward|forwards|ahead|further)/);
  if (m) {
    const n = parseFloat(m[1]) * 1000;
    const back = /earlier|before|back/.test(m[2]);
    const base = /^(go|skip|jump|rewind|fast)/.test(t) && /back|forward|ahead/.test(m[2]) ? "position" : "grounded";
    return { type: "relative_seek", deltaMs: back ? -n : n, base };
  }
  const m2 = t.match(/\b(back|rewind|forward|ahead|skip)\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/);
  if (m2) return { type: "relative_seek", deltaMs: (/back|rewind/.test(m2[1]) ? -1 : 1) * parseFloat(m2[2]) * 1000, base: "position" };
  return null;
}

function speed(t: string): Intent | null {
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:x|times)\s+slower/);
  if (m) return { type: "set_speed", rate: Math.max(0.25, 1 / parseFloat(m[1])) };
  if (/\bquarter speed\b/.test(t)) return { type: "set_speed", rate: 0.25 };
  if (/\bhalf[- ]?speed\b|\bhalf the speed\b/.test(t)) return { type: "set_speed", rate: 0.5 };
  if (/\b(normal|regular|full|real[- ]?time|usual) speed\b|\bspeed back to normal\b|\breal[- ]?time\b/.test(t)) return { type: "set_speed", rate: 1 };
  m = t.match(/(?:at|speed|play(?: it)?)\s*(\d?\.\d+|[0-2](?:\.\d+)?)\s*x?\b/) ?? t.match(/\b(\d?\.\d+|[0-2](?:\.\d+)?)\s*x\b/);
  if (m && /x\b|speed|\bat\b/.test(t)) {
    const r = parseFloat(m[1]);
    if (r >= 0.25 && r <= 2) return { type: "set_speed", rate: r };
  }
  if (/\bslow(er| it down| motion| mo|-mo)?\b|\bslowly\b/.test(t) && !/\breplay\b/.test(t)) return { type: "set_speed", rate: "slower" };
  if (/\bfaster\b|\bspeed (it )?up\b|\bdouble speed\b/.test(t)) return { type: "set_speed", rate: "faster" };
  return null;
}

const CONTENT_NOUN = /\b(movie|film|story|match|game|show|episode)\b/;
const TITLE_STOPWORDS = new Set(["the", "and", "vs", "fc", "of", "an"]);

/** Distinctive words of a title ("The Keeper's Key" → keeper, key). */
export function titleKeywords(title: string): string[] {
  return normalize(title)
    .replace(/'s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w));
}

/** "watch the keeper's key", "switch to the match", "put on the movie". */
function openContent(t: string, titles: string[]): Intent | null {
  const m = t.match(/^(?:let'?s |can you |could you |please )?(?:switch (?:over |back )?to|open|put on|start watching|go back to watching|watch|play)\s+(.+)$/);
  if (!m) return null;
  const rest = m[1];
  if (/\b(scene|moment|where|when|part|bit|goal|replay|it|that|this|again)\b/.test(rest)) return null;
  const titled = titles.some((title) => {
    const kw = titleKeywords(title);
    return kw.length > 0 && kw.filter((k) => new RegExp(`\\b${k}`).test(rest)).length >= Math.min(2, kw.length);
  });
  return titled || CONTENT_NOUN.test(rest) ? { type: "open_content", query: rest } : null;
}

export function parseClause(clause: string, titles: string[] = []): Intent {
  const t = normalize(clause);
  const open = openContent(t, titles);
  if (open) return open;

  // --- Viewing Memory
  if (/\b(what|which|who) (did|have) i\b|\b(what|which) \w+ (did|have) i\b|\bi (asked|clipped|shared|sent|replayed|looked up|searched)\b|\bmy (clips|history|activity)\b|\beverything i\b/.test(t)) {
    const types: string[] = [];
    if (/\bask|look(ed)? up|who\b/.test(t)) types.push("who_is_this");
    if (/\bclip/.test(t)) types.push("clip_created");
    if (/\bsen[dt]|\bshar/.test(t)) types.push("clip_shared");
    if (/\breplay|rewatch|loop/.test(t)) types.push("loop_moment", "rewatch_moment");
    return { type: "memory_query", text: t, types };
  }
  if (/\bspoilers? (off|on)\b|\bturn (off|on) spoilers?\b|\bshow me anyway\b|\bi don'?t mind spoilers\b|\bno spoilers\b/.test(t)) {
    const full = /\b(off|anyway|don'?t mind)\b/.test(t) && !/\bno spoilers\b/.test(t);
    return { type: "spoilers", mode: full ? "full" : "strict" };
  }
  if (/\bcatch me up\b|\bwhat did i miss\b|\brecap\b|\bi (was|looked|went) away\b|\bi missed\b/.test(t)) {
    const m = t.match(/(\d+(?:\.\d+)?)\s*(minutes?|mins?|seconds?|secs?)/);
    const windowMs = m ? parseFloat(m[1]) * (/^m/.test(m[2]) ? 60000 : 1000) : 60000;
    return { type: "catch_up", windowMs };
  }
  const wantsShare = /\b(send|share|text)\b/.test(t);
  if (/\bclip\b|\bmake a clip\b|\bsave (that|it|this)( moment| as a clip)?\b/.test(t)) {
    const rest = t.replace(/\b(clip|make a clip of|save)\b/g, " ");
    const spec = parseMomentSpec(rest);
    const explicit = spec && spec.eventTypes.length + (spec.replay ? 1 : 0) > 0 && (!spec.deictic || spec.ordinal !== undefined || spec.descriptive);
    return { type: "clip", spec: explicit ? spec : undefined, share: wantsShare };
  }
  if (wantsShare && /\b(phone|mobile|me|it|that|this)\b/.test(t)) return { type: "share" };
  if (/\b(back to live|return to live|go live|back to where i was|where i left off|jump to live|back to the live)\b/.test(t)) return { type: "return_live" };

  const sel = t.match(/^(?:the |go to the |show the |play the )?(first|second|third|fourth|fifth|last|next|previous|other) one\b/);
  if (sel) {
    const w = sel[1];
    return { type: "select_result", which: w === "next" || w === "other" ? "next" : w === "previous" ? "previous" : w === "last" ? "last" : ORDINALS[w] };
  }
  if (/^the one before (that|it)$/.test(t)) return { type: "select_result", which: "previous" };
  if (/^the one after (that|it)$/.test(t)) return { type: "select_result", which: "next" };

  if (/\b(stop|cancel|end) (the )?(loop(ing)?|repeat(ing)?)\b/.test(t)) return { type: "clear_loop" };

  const rel = relSeek(t);
  if (rel) return rel;
  const sp = speed(t);
  if (sp) {
    return sp;
  }
  const rep = t.match(/\b(repeat|loop)\b(?:.*?\b(\d+)\s*times\b)?/);
  if (rep) return { type: "loop", count: rep[2] ? Math.min(50, parseInt(rep[2], 10)) : rep[1] === "loop" ? 20 : 3 };
  if (/\b(\d+)\s*times\b/.test(t) && /\b(play|watch|show)\b/.test(t) && !parseMomentSpec(t)?.eventTypes.length) {
    return { type: "loop", count: Math.min(50, parseInt(t.match(/\b(\d+)\s*times\b/)![1], 10)) };
  }
  // "show me the equaliser again" names a moment: that's a seek, not a replay of the active one.
  if (/\bagain\b|\bone more time\b|\bonce more\b|\breplay (it|that|this)\b|\bplay (it|that) back\b/.test(t) && !parseMomentSpec(t.replace(/\bagain\b/g, " "))?.eventTypes.length)
    return { type: "again" };

  if (/^(pause|stop|hold on|freeze|wait)( it| there| that| here| the (video|match|game))?$/.test(t)) return { type: "pause" };
  if (/^(play|resume|continue|unpause|keep going|carry on|go on)( it| playing| the (video|match|game))?$/.test(t)) return { type: "play" };

  if (/\bwho('s| is| was)\b|\bwho has\b|\bwho scored\b|\bwhich player\b/.test(t) && !/\bwho did i\b/.test(t)) {
    if (/\bwho (scored|got) (that|it|this|the)\b|\bwho scored\b/.test(t)) return { type: "identify", target: "scorer" };
    if (/(#|\bnumber\s+|\bno\.?\s*)\d+|\bkeeper\b|\bgoal ?keeper\b/.test(t) || /\bwho (is|was) [a-z]{3,}\b/.test(t.replace(/\b(this|that|he|she|it|on|the|playing|in)\b/g, "")))
      return { type: "identify", target: "mention", mention: t };
    if (/\b(he|him|she|her)\b/.test(t)) return { type: "identify", target: "pronoun" };
    return { type: "identify", target: "ball_carrier" };
  }
  if (
    /\bread (out )?(the |that )?(score|scoreboard|sign|text|screen|clock|letter|note|map)\b|\bwhat('s| is) the score\b|\bwhat minute\b|\bhow long left\b/.test(t) ||
    /^read (that|this|it)( out| for me)?$|\bwhat does (that|it|this|the (sign|letter|note|map)) say\b/.test(t)
  )
    return { type: "read_text" };
  if (/\bwhat did (he|she|they|the commentators?|the commentary) (just )?say\b|\bwhat was (just )?said\b|\brepeat (that|the) line\b/.test(t)) return { type: "what_said" };
  if (/\bdescribe\b|\bwhat (just )?happened\b|\bexplain (that|this|what|the play)\b|\bwhat'?s going on\b|\bwhat is happening\b|\bwhat'?s happening\b|\bwhat are they doing\b/.test(t)) return { type: "describe" };

  const spec = parseMomentSpec(t);
  if (spec) {
    const listy = /\b(every|all|each|list|how many)\b/.test(t) || (spec.plural && /\b(show|find|see|give)\b/.test(t) && spec.ordinal === undefined);
    if (listy) return { type: "list_moments", spec };
    if (/\b(go|rewind|jump|take me|skip|back|show|play|find|seek|bring up|start|watch|to|where|when)\b/.test(t) || /^(the|that|his|her)\b/.test(t) || spec.replay || spec.ordinal !== undefined)
      return { type: "seek_moment", spec };
  }
  return { type: "unknown", text: clause };
}

export function parseUtterance(utterance: string, titles: string[] = []): Intent[] {
  const out: Intent[] = [];
  for (const i of splitClauses(utterance).map((c) => parseClause(c, titles))) {
    const prev = out[out.length - 1];
    // "I was away 5 minutes, catch me up" → one catch-up with the explicit window.
    if (prev && prev.type === "catch_up" && i.type === "catch_up") continue;
    out.push(i);
  }
  return out;
}
