import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { ContentIndex } from "../packages/contracts/src/index.ts";
import { resolveEntities } from "../services/agent/src/entities.ts";
import { MomentRetriever } from "../services/agent/src/retrieval.ts";

let index: ContentIndex;
const r = new MomentRetriever();
beforeAll(() => {
  index = JSON.parse(readFileSync("data/index/harbor-v-northgate.json", "utf8"));
});
const goalStart = (n: number) => index.events.find((e) => e.type === "goal" && e.goalNumber === n)!.startMs;

describe("temporal grounding over the demo match", () => {
  it("'the last goal' = nearest goal before the playhead", async () => {
    const res = await r.search(index, { query: "goal", eventTypes: ["goal"], relation: "before", order: "nearest" }, 150000);
    expect(res.moments[0].label).toMatch(/Goal 2 — Okafor/);
    const earlier = await r.search(index, { query: "goal", eventTypes: ["goal"], relation: "before", order: "nearest" }, 120000);
    expect(earlier.moments[0].label).toMatch(/Goal 1 — Silva/);
  });
  it("ordinal goals are chronological", async () => {
    const res = await r.search(index, { query: "goal", eventTypes: ["goal"], ordinal: 3 }, 0);
    expect(res.moments[0].label).toMatch(/Goal 3 — Silva/);
  });
  it("replay of a specific goal", async () => {
    const g = index.events.find((e) => e.type === "goal" && e.goalNumber === 2)!;
    const res = await r.search(index, { query: "replay", replayOfEventId: g.id }, 0);
    expect(res.moments[0]).toMatchObject({ kind: "replay", startMs: 152000 });
  });
  it("anchored relation: the save before the second goal", async () => {
    const res = await r.search(index, { query: "save", eventTypes: ["save"], relation: "before", anchorMs: goalStart(2), order: "nearest" }, 240000);
    expect(res.moments[0].label).toBe("Save — Brandt (#1) denies Lindqvist");
  });
  it("spoiler boundary hides future moments and reports them", async () => {
    const res = await r.search(index, { query: "goal", eventTypes: ["goal"], ordinal: 2, spoilerBoundaryMs: 125000 }, 125000);
    expect(res.moments).toHaveLength(0);
    expect(res.hiddenBySpoilerBoundary).toBe(2);
  });
  it("entity filter: Silva's shots and goals", async () => {
    const res = await r.search(index, { query: "shots", eventTypes: ["shot", "goal"], entityIds: ["player:HCFC:7"], order: "chronological" }, 0);
    expect(res.moments.map((m) => m.eventType)).toEqual(["shot", "goal", "shot", "goal"]);
  });
  it("free-text hybrid query finds the post", async () => {
    const res = await r.search(index, { query: "silva hits the post", includeWindows: true }, 0);
    expect(res.moments[0].label).toMatch(/Shot — Silva \(#7\) \(post\)/);
  });
});

describe("entity resolution", () => {
  it("disambiguates shirt numbers by recent involvement", () => {
    expect(resolveEntities(index, "who is number 7", 100000)[0].entity.name).toBe("Silva");
    expect(resolveEntities(index, "northgate's number 9", 0)[0].entity.name).toBe("Okafor");
    expect(resolveEntities(index, "number nine", 146000)[0].entity.name).toBe("Okafor");
  });
  it("roles and names", () => {
    expect(resolveEntities(index, "the harbor city keeper", 0)[0].entity.name).toBe("Brandt");
    expect(resolveEntities(index, "show me lindqvist", 0)[0].entity.id).toBe("player:NGU:5");
  });
});
