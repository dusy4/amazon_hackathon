/**
 * Bedrock Converse tool-use agent (enabled with SP_AGENT=bedrock).
 *
 * Used for utterances the deterministic parser cannot map. The model receives the Context Envelope
 * and the live MCP tool list; every tool call it makes is executed through the same MCP client and
 * appears in the same trace. Bedrock tool names cannot contain dots, so "player.seek" ⇄ "player__seek".
 */
import { BedrockRuntimeClient, ConverseCommand, type Message, type Tool } from "@aws-sdk/client-bedrock-runtime";
import type { ContextEnvelope, TraceStep } from "../../../packages/contracts/src/index.ts";

type Call = (name: string, args?: Record<string, unknown>) => Promise<unknown>;
type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown> };

const toBedrock = (n: string) => n.replace(/\./g, "__");
const fromBedrock = (n: string) => n.replace(/__/g, ".");

export class BedrockAgent {
  readonly modelId = process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-2-lite-v1:0";
  private client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  get label() {
    return `bedrock:${this.modelId}`;
  }

  async run(utterance: string, envelope: ContextEnvelope, call: Call, step: (s: Omit<TraceStep, "ms">) => void, listTools: () => Promise<McpTool[]>) {
    const tools: Tool[] = (await listTools()).map((t) => ({
      toolSpec: { name: toBedrock(t.name), description: t.description ?? t.name, inputSchema: { json: t.inputSchema as never } },
    }));
    const system =
      "You control the video the user is watching on their TV through tools. Ground references with moments.search, " +
      "entities.resolve or lens.* before acting; then use player.* primitives. Relative changes after grounding are arithmetic " +
      "on the grounded startMs. Never reveal events after relevantCore.spoilerBoundaryMs when spoilerMode is strict. " +
      "Reply in one or two short spoken sentences.\n\nContext Envelope:\n" +
      JSON.stringify(envelope);
    const messages: Message[] = [{ role: "user", content: [{ text: utterance }] }];
    for (let turn = 0; turn < 6; turn++) {
      step({ kind: "intent", label: `Converse turn ${turn + 1}`, component: this.label });
      const res = await this.client.send(
        new ConverseCommand({ modelId: this.modelId, system: [{ text: system }], messages, toolConfig: { tools }, inferenceConfig: { maxTokens: 600, temperature: 0 } }),
      );
      const msg = res.output?.message;
      if (!msg) break;
      messages.push(msg);
      const uses = (msg.content ?? []).filter((b) => b.toolUse).map((b) => b.toolUse!);
      if (res.stopReason !== "tool_use" || !uses.length) return (msg.content ?? []).map((b) => b.text ?? "").join(" ").trim();
      const results: Message = { role: "user", content: [] };
      for (const u of uses) {
        try {
          const out = await call(fromBedrock(u.name!), (u.input ?? {}) as Record<string, unknown>);
          results.content!.push({ toolResult: { toolUseId: u.toolUseId!, content: [{ json: out as never }] } });
        } catch (e) {
          results.content!.push({ toolResult: { toolUseId: u.toolUseId!, status: "error", content: [{ text: (e as Error).message }] } });
        }
      }
      messages.push(results);
    }
    return "Done.";
  }
}
