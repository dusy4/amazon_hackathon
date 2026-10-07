/**
 * LLM agent (primary interpreter): utterance + Context Envelope → tool calls over MCP → spoken reply.
 *
 * The model interprets intent, resolves references against the envelope and chooses tools; every tool
 * it calls is a deterministic MCP tool executed by our server (Anthropic, "Building effective agents":
 * augmented LLM + well-documented tools, bounded loop, transparent steps). The loop is capped and every
 * call lands in the same trace as the rules path.
 */
import type { ContextEnvelope, TraceStep } from "../../../packages/contracts/src/index.ts";
import type { ChatMessage, ChatModel, ToolSpec } from "./llm.ts";

type Call = (name: string, args?: Record<string, unknown>) => Promise<unknown>;
type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown> };

const MAX_TURNS = 10;

const POLICY = `You are the playback agent for a TV. The viewer speaks to you while watching; you act through tools.

How to act:
- Ground first, then act. To find a moment call moments.search with a descriptive query plus structured arguments: eventTypes ONLY from relevantCore.momentTypes (omit it when unsure — the query alone is searched semantically), entityNames for people ("Silva", "#9 Northgate", "Theo"), ordinal for "the second goal", relation "before" + order "nearest" for "the last …", replayOfEventId for "the replay of <event>" (search the event first, then its replay). Then call player.seek with the returned startMs.
- "That goal / the replay / it / him / her" refer to relevantCore.activeReference and activeEntity in the Context Envelope. Do not search again for something already grounded.
- Relative changes ("three seconds earlier", "skip 10 seconds") use player.seek_relative — never recompute positions yourself.
- Speed: player.set_speed (slower = 0.5, much slower = 0.25, normal = 1). Repeat N times: player.loop with the grounded moment's startMs/endMs and count N. Again: player.play_segment.
- Clips: clip.create with the grounded moment's range (max 60 s), then share.send with the clipId when the viewer wants it on their phone.
- Who is this / read that / what did they say / what happened / catch me up: lens.identify, lens.read_text, transcript.window, moments.summarize. Use the current playback position from the envelope.
- Other titles: content.open with the contentId from the catalog.
- Spoilers: when spoilerMode is "strict", never mention or seek to anything after spoilerBoundaryMs. If moments.search reports bestMatchHidden or only hidden matches, tell the viewer it hasn't happened yet for them and offer "spoilers off".
- Time words are arguments, not query text: "at the start / the first time / opening" → order "first"; "the last / most recent / just now" → relation "before" + order "nearest"; "after X" / "before X" → relation with anchorMs from the grounded moment; "the second …" → ordinal 2. Keep the query about WHAT happens.
- Check each result's description and evidence (the spoken line that matched) before choosing; the label alone can be generic.
- "When does …?" questions: seek to the moment AND say the time.
- Never repeat the same search. If moments.search returns moments, pick the best one and act; if it returns none, rephrase once without filters, then tell the viewer.
- If the request is genuinely ambiguous, ask one short clarifying question instead of guessing.
- Execute multi-step requests in order. Finish with one or two short spoken sentences describing what you did; no markdown, no JSON.`;

export class LlmAgent {
  constructor(private model: ChatModel) {}
  get label() {
    return this.model.label;
  }

  async run(
    utterance: string,
    envelope: ContextEnvelope,
    catalog: { contentId: string; title: string; kind: string }[],
    call: Call,
    step: (s: Omit<TraceStep, "ms">) => void,
    listTools: () => Promise<McpTool[]>,
  ): Promise<string> {
    const tools: ToolSpec[] = (await listTools()).map((t) => ({ name: t.name, description: t.description ?? t.name, parameters: t.inputSchema }));
    const system = `${POLICY}\n\nCatalog: ${JSON.stringify(catalog)}\n\nContext Envelope:\n${JSON.stringify(envelope)}`;
    const messages: ChatMessage[] = [{ role: "user", content: utterance }];
    let searches = 0;
    let nudged = false;
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const t0 = Date.now();
      const res = await this.model.complete(system, messages, tools);
      step({ kind: "intent", label: `LLM turn ${turn}: ${res.toolCalls.length ? res.toolCalls.map((c) => c.name).join(", ") : "reply"} (${Date.now() - t0} ms)`, component: `llm:${res.model}`, data: res.toolCalls.map((c) => ({ tool: c.name, args: c.args })) });
      messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
      if (!res.toolCalls.length) return res.text.trim() || "Done.";
      for (const c of res.toolCalls) {
        let content: string;
        try {
          content = JSON.stringify(await call(c.name, c.args));
        } catch (e) {
          content = JSON.stringify({ error: (e as Error).message });
        }
        messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: content.slice(0, 6000) });
        if (c.name === "moments.search") searches++;
      }
      // Bounded agent: after three searches the controller asks for a decision instead of another search.
      if (searches >= 3 && !nudged) {
        nudged = true;
        step({ kind: "intent", label: "controller: 3 searches — choose the best result or ask the viewer", component: "llm-agent" });
        messages.push({
          role: "user",
          content:
            "(controller) You have searched three times. Do not search again. Pick the best moment from the results above (check description and evidence) and act on it, " +
            "or, if two candidates are equally plausible, ask the viewer one short question naming them with their times.",
        });
      }
    }
    return messages.filter((m) => m.role === "assistant" && m.content).map((m) => m.content).pop()?.trim() || "Done.";
  }
}
