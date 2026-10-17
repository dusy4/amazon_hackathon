/**
 * Amazon Bedrock AgentCore Memory: the agent's conversational memory, next to DynamoDB Viewing Memory.
 *
 * DynamoDB stays the canonical, timestamped product history (deterministic, deletable). AgentCore Memory gets
 * the same actions as short-term conversational events per viewing session, so an AgentCore-hosted agent (or
 * Alexa+ later) can read "what happened in this session" without our database. Writes never block a request.
 */
import { BedrockAgentCoreClient, CreateEventCommand, ListEventsCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { ActionEvent } from "../../../packages/contracts/src/index.ts";

const clean = (s: string) => s.replace(/[^a-zA-Z0-9\-_]/g, "-").slice(0, 90);

export class AgentCoreMemory {
  private client = new BedrockAgentCoreClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  private lastError: string | null = null;
  constructor(readonly memoryId: string) {}

  sessionOf(e: { sessionId: string; wallClock?: string }) {
    return clean(`${e.sessionId}-${(e.wallClock ?? new Date().toISOString()).slice(0, 10)}`);
  }

  async append(e: ActionEvent) {
    try {
      await this.client.send(new CreateEventCommand({
        memoryId: this.memoryId,
        actorId: clean(e.userId),
        sessionId: this.sessionOf(e),
        eventTimestamp: new Date(e.wallClock),
        payload: [{ conversational: { role: "USER", content: { text: `[${e.type}${e.contentId ? ` · ${e.contentId}` : ""}${e.contentTimeMs != null ? ` @ ${Math.round(e.contentTimeMs / 1000)} s` : ""}] ${e.summary}` } } }],
      }));
      this.lastError = null;
    } catch (err) {
      const msg = ((err as Error).message ?? String(err)).slice(0, 120);
      if (msg !== this.lastError) console.warn(`[agentcore-memory] write failed: ${msg}`);
      this.lastError = msg;
    }
  }

  /** This session's events, newest first. */
  async session(userId: string, sessionId: string, limit = 5) {
    const r = await this.client.send(new ListEventsCommand({
      memoryId: this.memoryId, actorId: clean(userId), sessionId: this.sessionOf({ sessionId }), maxResults: Math.max(limit, 20), includePayloads: true,
    }));
    return (r.events ?? [])
      .map((ev) => ({ at: ev.eventTimestamp?.toISOString(), text: (ev.payload?.[0] as any)?.conversational?.content?.text as string }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, limit);
  }
}

export const agentCoreMemory = process.env.SP_AGENTCORE_MEMORY_ID ? new AgentCoreMemory(process.env.SP_AGENTCORE_MEMORY_ID) : null;
