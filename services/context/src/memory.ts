/**
 * Viewing Memory — the canonical log of user-meaningful actions (v2: "DynamoDB = canonical event log").
 *
 * FileViewingMemory (default) appends JSON lines to data/memory/events.jsonl.
 * DynamoViewingMemory writes the same ActionEvent items to a DynamoDB table
 * (partition key userId, sort key sk = wallClock#id) when SP_MEMORY=dynamodb.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { ActionEvent } from "../../../packages/contracts/src/index.ts";
import { tokenize } from "../../media/src/text.ts";

export interface MemoryQuery {
  userId: string;
  text?: string;
  types?: ActionEvent["type"][];
  entityIds?: string[];
  limit?: number;
}

export interface ViewingMemory {
  readonly backend: string;
  append(e: ActionEvent): Promise<void>;
  recent(userId: string, limit: number): Promise<ActionEvent[]>;
  search(q: MemoryQuery): Promise<{ event: ActionEvent; score: number }[]>;
}

export function rankEvents(events: ActionEvent[], q: MemoryQuery) {
  const qt = new Set(tokenize(q.text ?? ""));
  return events
    .filter((e) => e.userId === q.userId)
    .filter((e) => !q.types?.length || q.types.includes(e.type))
    .filter((e) => !q.entityIds?.length || e.entityIds.some((id) => q.entityIds!.includes(id)))
    .map((e) => {
      const et = tokenize(`${e.type.replace(/_/g, " ")} ${e.summary}`);
      const lex = qt.size ? et.filter((t) => qt.has(t)).length / qt.size : 0;
      const recency = 1 / (1 + (Date.now() - Date.parse(e.wallClock)) / 3.6e6);
      return { event: e, score: lex + 0.1 * recency };
    })
    .sort((a, b) => b.score - a.score || Date.parse(b.event.wallClock) - Date.parse(a.event.wallClock))
    .slice(0, q.limit ?? 10);
}

export class FileViewingMemory implements ViewingMemory {
  readonly backend = "file:data/memory/events.jsonl";
  private cache: ActionEvent[] = [];
  constructor(private path: string) {
    if (existsSync(path)) {
      this.cache = readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    }
  }
  async append(e: ActionEvent) {
    if (!existsSync(dirname(this.path))) mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(e) + "\n");
    this.cache.push(e);
  }
  async recent(userId: string, limit: number) {
    return this.cache.filter((e) => e.userId === userId).slice(-limit).reverse();
  }
  async search(q: MemoryQuery) {
    return rankEvents(this.cache, q);
  }
}

export class DynamoViewingMemory implements ViewingMemory {
  readonly backend: string;
  private doc: DynamoDBDocumentClient;
  constructor(private table: string, region = process.env.AWS_REGION ?? "us-east-1") {
    this.backend = `dynamodb:${table}`;
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  }
  async append(e: ActionEvent) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...e, sk: `${e.wallClock}#${e.id}` } }));
  }
  async recent(userId: string, limit: number) {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (r.Items ?? []) as ActionEvent[];
  }
  async search(q: MemoryQuery) {
    return rankEvents(await this.recent(q.userId, 500), q);
  }
}

export function createViewingMemory(dataDir: string): ViewingMemory {
  if (process.env.SP_MEMORY === "dynamodb") {
    return new DynamoViewingMemory(process.env.VIEWING_MEMORY_TABLE ?? "semantic-playback-viewing-memory");
  }
  return new FileViewingMemory(`${dataDir}/memory/events.jsonl`);
}
