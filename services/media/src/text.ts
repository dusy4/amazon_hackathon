/**
 * Tokenisation + light normalisation shared by the index builder and query-time retrieval.
 * Synonym folding keeps lexical matching robust ("booking" ↔ "yellow card", "scores" ↔ "goal").
 */
const STOP = new Set(
  "a an the of to in on at for and or but is are was were be been it its this that these those me my i you he she his her him they them we our with from by as into up out so then there here what when where which who whom do does did just can could please show go back take let lets let's again".split(
    " ",
  ),
);

const SYNONYMS: Record<string, string> = {
  goals: "goal",
  scored: "goal",
  scores: "goal",
  score: "goal",
  scoring: "goal",
  finish: "goal",
  finishes: "goal",
  equaliser: "goal",
  equalizer: "goal",
  saves: "save",
  saved: "save",
  stop: "save",
  stopped: "save",
  keeper: "goalkeeper",
  goalie: "goalkeeper",
  gk: "goalkeeper",
  replays: "replay",
  rerun: "replay",
  "slow-motion": "replay",
  booking: "yellow",
  booked: "yellow",
  card: "yellow",
  cards: "yellow",
  fouled: "foul",
  fouls: "foul",
  tackled: "foul",
  shots: "shot",
  shoots: "shot",
  shooting: "shot",
  headed: "header",
  heads: "header",
  headers: "header",
  corners: "corner",
  passes: "pass",
  crossed: "cross",
  crosses: "cross",
  celebrates: "celebration",
  celebrating: "celebration",
  celebrate: "celebration",
  woodwork: "post",
  crossbar: "post",
  whistle: "whistle",
  kickoff: "kickoff",
  "kick-off": "kickoff",
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/#(\d+)/g, " number$1 ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length > 0 && !STOP.has(t))
    .map((t) => SYNONYMS[t] ?? t);
}

/** BM25 over a fixed corpus. */
export class Bm25 {
  private docs: string[][];
  private df = new Map<string, number>();
  private avgLen: number;
  constructor(texts: string[], private k1 = 1.2, private b = 0.75) {
    this.docs = texts.map(tokenize);
    for (const d of this.docs) for (const t of new Set(d)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length);
  }
  score(query: string): number[] {
    const q = tokenize(query);
    const N = this.docs.length;
    return this.docs.map((d) => {
      let s = 0;
      for (const t of q) {
        const f = d.filter((x) => x === t).length;
        if (!f) continue;
        const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.length) / this.avgLen));
      }
      return s;
    });
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
