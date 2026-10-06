import { describe, expect, it } from "vitest";
import { parseUtterance, splitClauses } from "../services/agent/src/intent.ts";

const types = (u: string) => parseUtterance(u).map((i) => i.type);

describe("clause splitting", () => {
  it("splits the north-star command into ordered steps", () => {
    expect(
      types("Rewind to the replay of the last goal, start three seconds before it, play it slower, repeat it five times, clip it, and send it to my phone."),
    ).toEqual(["seek_moment", "relative_seek", "set_speed", "loop", "clip", "share"]);
  });
  it("strips the wake word and filler", () => {
    expect(splitClauses("Alexa, okay, go back to the goal")).toEqual(["go back to the goal"]);
  });
  it("does not split inside a single request", () => {
    expect(types("go to the save before the second goal")).toEqual(["seek_moment"]);
  });
});

describe("moment references", () => {
  it("replay of the last goal", () => {
    const [i] = parseUtterance("go back to the replay of the last goal");
    expect(i).toMatchObject({ type: "seek_moment", spec: { replay: true, eventTypes: ["goal"], ordinal: "last" } });
  });
  it("deictic: that goal", () => {
    const [i] = parseUtterance("the replay of that goal");
    expect(i).toMatchObject({ type: "seek_moment", spec: { replay: true, deictic: true } });
  });
  it("ordinal goal", () => {
    expect(parseUtterance("show me the second goal")[0]).toMatchObject({ spec: { ordinal: 2, eventTypes: ["goal"] } });
  });
  it("anchored: save before the second goal", () => {
    const [i] = parseUtterance("go to the save before the second goal");
    expect(i).toMatchObject({ type: "seek_moment", spec: { eventTypes: ["save"], anchor: { relation: "before", spec: { ordinal: 2 } } } });
  });
  it("plural + pronoun → list", () => {
    expect(parseUtterance("show me his shots")[0]).toMatchObject({ type: "list_moments", spec: { pronoun: true } });
    expect(types("show every yellow card so far")).toEqual(["list_moments"]);
  });
  it("selection from a result set", () => {
    expect(parseUtterance("the second one")[0]).toEqual({ type: "select_result", which: 2 });
    expect(parseUtterance("the one before that")[0]).toEqual({ type: "select_result", which: "previous" });
    expect(parseUtterance("next one")[0]).toEqual({ type: "select_result", which: "next" });
  });
});

describe("deterministic follow-ups", () => {
  it("relative seeks anchor to the grounded moment", () => {
    expect(parseUtterance("three seconds earlier")[0]).toEqual({ type: "relative_seek", deltaMs: -3000, base: "grounded" });
    expect(parseUtterance("go back 10 seconds")[0]).toEqual({ type: "relative_seek", deltaMs: -10000, base: "position" });
    expect(parseUtterance("5 seconds later")[0]).toEqual({ type: "relative_seek", deltaMs: 5000, base: "grounded" });
  });
  it("speed", () => {
    expect(parseUtterance("half speed")[0]).toEqual({ type: "set_speed", rate: 0.5 });
    expect(parseUtterance("play it 3 times slower")[0]).toMatchObject({ type: "set_speed" });
    expect(parseUtterance("play it at 0.75x")[0]).toEqual({ type: "set_speed", rate: 0.75 });
    expect(parseUtterance("normal speed")[0]).toEqual({ type: "set_speed", rate: 1 });
    expect(parseUtterance("slower")[0]).toEqual({ type: "set_speed", rate: "slower" });
  });
  it("loops and again", () => {
    expect(parseUtterance("repeat it five times")[0]).toEqual({ type: "loop", count: 5 });
    expect(parseUtterance("repeat it twice")[0]).toEqual({ type: "loop", count: 2 });
    expect(types("again")).toEqual(["again"]);
    expect(types("stop looping")).toEqual(["clear_loop"]);
  });
  it("transport", () => {
    expect(types("pause")).toEqual(["pause"]);
    expect(types("resume")).toEqual(["play"]);
    expect(types("back to live")).toEqual(["return_live"]);
  });
});

describe("lens, accessibility, memory", () => {
  it("identify variants", () => {
    expect(parseUtterance("who is number 7?")[0]).toMatchObject({ type: "identify", target: "mention" });
    expect(parseUtterance("who has the ball")[0]).toMatchObject({ type: "identify", target: "ball_carrier" });
    expect(parseUtterance("who scored that")[0]).toMatchObject({ type: "identify", target: "scorer" });
    expect(parseUtterance("who is he")[0]).toMatchObject({ type: "identify", target: "pronoun" });
  });
  it("screen text, transcript, description, catch-up", () => {
    expect(types("read the score")).toEqual(["read_text"]);
    expect(types("what did he just say?")).toEqual(["what_said"]);
    expect(types("describe what just happened")).toEqual(["describe"]);
    expect(parseUtterance("I was away for 2 minutes, catch me up")).toEqual([{ type: "catch_up", windowMs: 120000 }]);
  });
  it("memory queries", () => {
    expect(parseUtterance("who was the player I asked about?")[0]).toMatchObject({ type: "memory_query", types: ["who_is_this"] });
    expect(parseUtterance("what clips did I send")[0]).toMatchObject({ type: "memory_query" });
  });
  it("clip + share in one clause", () => {
    expect(parseUtterance("clip that and send it to my phone")).toMatchObject([{ type: "clip" }, { type: "share" }]);
  });
});
