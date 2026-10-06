/**
 * Chat model providers for the agent (tool calling). One message format inside the agent; each
 * provider converts at the edge.
 *
 *  - OpenRouterChat: OpenAI-compatible Chat Completions on openrouter.ai (SP_LLM=openrouter). Used while
 *    the AWS account cannot invoke Bedrock models; `OPENROUTER_MODELS` is a comma-separated fallback list.
 *  - BedrockChat: Amazon Bedrock Converse (SP_LLM=bedrock), e.g. us.amazon.nova-2-lite-v1:0.
 */
import { BedrockRuntimeClient, ConverseCommand, type Message as BrMessage } from "@aws-sdk/client-bedrock-runtime";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  model: string;
}

export interface ChatModel {
  readonly label: string;
  complete(system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResult>;
}

/** Tool names may not contain dots on most providers: "player.seek" ⇄ "player__seek". */
export const toWire = (n: string) => n.replace(/\./g, "__");
export const fromWire = (n: string) => n.replace(/__/g, ".");

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw || "{}"));
  } catch {
    return {};
  }
}

export class OpenRouterChat implements ChatModel {
  readonly models: string[];
  constructor(
    private apiKey = process.env.OPENROUTER_API_KEY ?? "",
    models = process.env.OPENROUTER_MODELS ?? "nvidia/nemotron-3-super-120b-a12b:free,nvidia/nemotron-3.5-lightning:free",
  ) {
    this.models = models.split(",").map((m) => m.trim()).filter(Boolean);
    if (!this.apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  }
  get label() {
    return `openrouter:${this.models[0]}`;
  }

  async complete(system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResult> {
    const body = {
      models: this.models,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        ...messages.map((m) =>
          m.role === "tool"
            ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
            : m.role === "assistant"
              ? {
                  role: "assistant",
                  content: m.content || null,
                  tool_calls: m.toolCalls?.map((t) => ({ id: t.id, type: "function", function: { name: toWire(t.name), arguments: JSON.stringify(t.args) } })),
                }
              : m,
        ),
      ],
      tools: tools.map((t) => ({ type: "function", function: { name: toWire(t.name), description: t.description, parameters: t.parameters } })),
    };
    // Free models are rate limited per minute: retry 429s with backoff (Retry-After when given).
    let res: Response | undefined;
    let j: any;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "x-title": "Semantic Playback" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      });
      j = await res.json();
      const limited = res.status === 429 || j?.error?.code === 429;
      if (!limited || attempt === 3) break;
      const wait = Number(res.headers.get("retry-after")) * 1000 || 2000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 15000)));
    }
    if (!res!.ok || j.error) throw new Error(`OpenRouter ${res!.status}: ${j.error?.message ?? "error"}`);
    const msg = j.choices?.[0]?.message ?? {};
    return {
      text: msg.content ?? "",
      model: j.model ?? this.models[0],
      toolCalls: (msg.tool_calls ?? []).map((t: any) => ({ id: t.id, name: fromWire(t.function.name), args: parseArgs(t.function.arguments) })),
    };
  }
}

export class BedrockChat implements ChatModel {
  readonly modelId = process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-2-lite-v1:0";
  private client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  get label() {
    return `bedrock:${this.modelId}`;
  }

  async complete(system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResult> {
    const br: BrMessage[] = [];
    for (const m of messages) {
      if (m.role === "user") br.push({ role: "user", content: [{ text: m.content }] });
      else if (m.role === "assistant")
        br.push({
          role: "assistant",
          content: [...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls ?? []).map((t) => ({ toolUse: { toolUseId: t.id, name: toWire(t.name), input: t.args as never } }))],
        });
      else {
        const block = { toolResult: { toolUseId: m.toolCallId, content: [{ text: m.content }] } };
        const last = br[br.length - 1];
        if (last?.role === "user" && last.content?.every((c) => c.toolResult)) last.content.push(block);
        else br.push({ role: "user", content: [block] });
      }
    }
    const res = await this.client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: system }],
        messages: br,
        toolConfig: { tools: tools.map((t) => ({ toolSpec: { name: toWire(t.name), description: t.description, inputSchema: { json: t.parameters as never } } })) },
        inferenceConfig: { maxTokens: 800, temperature: 0 },
      }),
    );
    const content = res.output?.message?.content ?? [];
    return {
      text: content.map((b) => b.text ?? "").join(" ").trim(),
      model: this.modelId,
      toolCalls: content.filter((b) => b.toolUse).map((b) => ({ id: b.toolUse!.toolUseId!, name: fromWire(b.toolUse!.name!), args: (b.toolUse!.input ?? {}) as Record<string, unknown> })),
    };
  }
}

export function defaultChatModel(): ChatModel | null {
  const which = process.env.SP_LLM ?? (process.env.SP_AGENT === "bedrock" ? "bedrock" : "");
  if (which === "openrouter") return new OpenRouterChat();
  if (which === "bedrock") return new BedrockChat();
  return null;
}
