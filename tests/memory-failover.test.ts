import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActionEvent } from "../packages/contracts/src/index.ts";
import { FailoverViewingMemory, FileViewingMemory, type ViewingMemory } from "../services/context/src/memory.ts";

const broken: ViewingMemory = {
  backend: "dynamodb:test",
  append: async () => {
    throw new Error("Your session has expired. Please reauthenticate.");
  },
  recent: async () => {
    throw new Error("Your session has expired. Please reauthenticate.");
  },
  search: async () => {
    throw new Error("Your session has expired. Please reauthenticate.");
  },
};

const ev = (summary: string): ActionEvent => ({
  id: summary, userId: "u", sessionId: "s", type: "who_is_this", contentId: null, contentTimeMs: null,
  wallClock: new Date().toISOString(), summary, entityIds: [], payload: {}, sourceDevice: "test", privacy: "user_activity",
});

describe("Viewing Memory failover", () => {
  it("keeps turns working when the primary store's credentials expire", async () => {
    const local = new FileViewingMemory(join(mkdtempSync(join(tmpdir(), "sp-mem-")), "events.jsonl"));
    const m = new FailoverViewingMemory(broken, local);
    await m.append(ev("Asked about Silva"));
    expect((await m.recent("u", 5)).map((e) => e.summary)).toEqual(["Asked about Silva"]);
    expect((await m.search({ userId: "u", text: "silva" }))[0].event.summary).toBe("Asked about Silva");
    expect(m.backend).toMatch(/fallback: dynamodb:test unavailable — Your session has expired/);
  });
});
