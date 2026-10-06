/**
 * Second-stage reranking (v3 retrieval: wide hybrid candidate set → cross-encoder rerank → top-k).
 *
 *  - BedrockReranker: Cohere Rerank 3.5 through the Amazon Bedrock Rerank API (the reranker available
 *    in us-east-1; Amazon Rerank 1.0 is not offered there). Enabled with SP_RERANK=bedrock.
 *  - No reranker: the fused first-stage ranking is used as is.
 *
 * Rerank failures never fail a search: the caller keeps the first-stage order and the trace says why.
 */
import { BedrockAgentRuntimeClient, RerankCommand } from "@aws-sdk/client-bedrock-agent-runtime";

export interface Reranker {
  readonly model: string;
  /** Returns relevance scores aligned with `docs`. */
  score(query: string, docs: string[]): Promise<number[]>;
}

export class BedrockReranker implements Reranker {
  readonly model: string;
  private client: BedrockAgentRuntimeClient;
  constructor(region = process.env.AWS_REGION ?? "us-east-1", modelId = process.env.RERANK_MODEL_ID ?? "cohere.rerank-v3-5:0") {
    this.model = modelId;
    this.client = new BedrockAgentRuntimeClient({ region });
    this.arn = `arn:aws:bedrock:${region}::foundation-model/${modelId}`;
  }
  private arn: string;

  async score(query: string, docs: string[]): Promise<number[]> {
    const res = await this.client.send(
      new RerankCommand({
        queries: [{ type: "TEXT", textQuery: { text: query } }],
        sources: docs.map((text) => ({ type: "INLINE", inlineDocumentSource: { type: "TEXT", textDocument: { text } } })),
        rerankingConfiguration: {
          type: "BEDROCK_RERANKING_MODEL",
          bedrockRerankingConfiguration: { modelConfiguration: { modelArn: this.arn }, numberOfResults: docs.length },
        },
      }),
    );
    const out = new Array<number>(docs.length).fill(0);
    for (const r of res.results ?? []) out[r.index!] = r.relevanceScore ?? 0;
    return out;
  }
}

export function defaultReranker(): Reranker | null {
  return process.env.SP_RERANK === "bedrock" ? new BedrockReranker() : null;
}
