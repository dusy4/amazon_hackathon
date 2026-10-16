import { describe, expect, it } from "vitest";
import type { ContextEnvelope } from "../packages/contracts/src/index.ts";
import { LlmAgent, LlmDeadlineError } from "../services/agent/src/llm-agent.ts";

describe("LLM deadline", () => {
  it("a model answer that arrives after the deadline never executes its tool calls", async () => {
    const slowModel = {
      label: "fake:slow",
      complete: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return { text: "", model: "fake", toolCalls: [{ id: "1", name: "player.seek", args: { positionMs: 1000 } }] };
      },
    };
    const calls: string[] = [];
    const agent = new LlmAgent(slowModel as never);
    const run = agent.run("go somewhere", {} as ContextEnvelope, [], async (name) => (calls.push(name), {}), () => {}, async () => [], Date.now() + 50);
    await expect(run).rejects.toBeInstanceOf(LlmDeadlineError);
    expect(calls).toEqual([]);
  });
});
