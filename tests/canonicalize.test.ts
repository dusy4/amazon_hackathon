import { describe, expect, it } from "vitest";
import { canonicalize, findMerges } from "../services/media/src/canonicalize.ts";

const person = (id: string, name: string, rekognition: boolean) => ({
  id, type: "person" as const, name, aliases: [name.split(" ").pop()!],
  description: rekognition ? "identified by amazon-rekognition RecognizeCelebrities + llm-description" : "identified by llm-description",
});

describe("entity canonicalisation", () => {
  const entities = [
    person("person:robbie-keane", "Robbie Keane", true),
    person("person:robbie-king", "Robbie King", false),
    person("person:bobby-keen", "Bobby Keen", false),
    person("person:usain-bolt", "Usain Bolt", true),
    person("person:ken-saturday", "Ken Saturday", false),
  ];

  it("merges caption mishearings into names Rekognition recognised", () => {
    const m = findMerges({ entities } as never);
    expect(m.get("person:robbie-king")).toBe("person:robbie-keane");
    expect(m.get("person:bobby-keen")).toBe("person:robbie-keane");
    expect(m.has("person:ken-saturday")).toBe(false); // no trusted near-miss: left alone
    expect(m.has("person:usain-bolt")).toBe(false);
  });

  it("rewrites events and segments and keeps the misheard name as an alias", () => {
    const index = {
      entities: structuredClone(entities),
      events: [{ id: "e1", type: "goal", startMs: 0, endMs: 1, title: "Robbie King scores screamer", description: "Robbie King scores an absolute screamer.", entityIds: ["person:robbie-king"], players: [] }],
      segments: [{ id: "s1", label: "Robbie King scores screamer", text: "Robbie King scores", entityIds: ["person:robbie-king"] }],
    } as never;
    const { index: out } = canonicalize(index) as any;
    expect(out.events[0].description).toBe("Robbie Keane scores an absolute screamer.");
    expect(out.events[0].entityIds).toEqual(["person:robbie-keane"]);
    expect(out.segments[0].label).toBe("Robbie Keane scores screamer");
    expect(out.entities.find((e: any) => e.id === "person:robbie-keane").aliases).toContain("Robbie King");
    expect(out.entities.some((e: any) => e.id === "person:robbie-king")).toBe(false);
  });
});
