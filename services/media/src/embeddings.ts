/**
 * Embedding providers.
 *
 *  - NovaEmbedder: Amazon Nova Multimodal Embeddings via Bedrock Runtime InvokeModel
 *    (model amazon.nova-2-multimodal-embeddings-v1:0, SINGLE_EMBEDDING text requests).
 *  - LocalHashEmbedder: dependency-free development fallback (feature hashing over normalised
 *    tokens + bigrams). It is NOT a learned semantic model; the UI and index label it as such.
 *
 * The index records which model built it; queries must be embedded with the same model.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { tokenize } from "./text.ts";

export type EmbeddingPurpose = "index" | "query";

export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]>;
}

export class LocalHashEmbedder implements Embedder {
  readonly model = "local-hash-v1";
  constructor(readonly dim = 384) {}

  private hash(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  embedOne(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const toks = tokenize(text);
    const feats = [...toks, ...toks.slice(1).map((t, i) => `${toks[i]}_${t}`)];
    for (const f of feats) {
      const h = this.hash(f);
      v[h % this.dim] += (h & 0x80000000 ? -1 : 1) * (f.includes("_") ? 0.5 : 1);
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

export class NovaEmbedder implements Embedder {
  readonly model: string;
  private client: BedrockRuntimeClient;
  constructor(
    readonly dim: 256 | 384 | 1024 | 3072 = 1024,
    model = process.env.NOVA_EMBED_MODEL_ID ?? "amazon.nova-2-multimodal-embeddings-v1:0",
    region = process.env.AWS_REGION ?? "us-east-1",
  ) {
    this.model = model;
    this.client = new BedrockRuntimeClient({ region });
  }

  async embed(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]> {
    const out: number[][] = [];
    for (const value of texts) {
      const body = {
        taskType: "SINGLE_EMBEDDING",
        singleEmbeddingParams: {
          embeddingPurpose: purpose === "index" ? "GENERIC_INDEX" : "GENERIC_RETRIEVAL",
          embeddingDimension: this.dim,
          text: { truncationMode: "END", value },
        },
      };
      const res = await this.client.send(
        new InvokeModelCommand({
          modelId: this.model,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify(body),
        }),
      );
      const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { embeddings: { embedding: number[] }[] };
      out.push(parsed.embeddings[0].embedding);
    }
    return out;
  }
}

export function embedderFor(model: string, dim: number): Embedder {
  if (model === "local-hash-v1") return new LocalHashEmbedder(dim);
  return new NovaEmbedder(dim as 1024, model);
}

export function defaultEmbedder(): Embedder {
  return process.env.SP_EMBEDDINGS === "nova" ? new NovaEmbedder() : new LocalHashEmbedder();
}
