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

/**
 * Learned text embeddings through OpenRouter's embeddings API (SP_EMBEDDINGS=openrouter), used while the
 * AWS account cannot invoke Nova Multimodal Embeddings. Model ids are stored as "openrouter:<model>".
 */
export class OpenRouterEmbedder implements Embedder {
  readonly model: string;
  dim = 0;
  constructor(private modelId = process.env.OPENROUTER_EMBED_MODEL ?? "nvidia/nemotron-3-embed-1b:free") {
    this.model = `openrouter:${modelId}`;
  }

  async embed(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]> {
    const out: number[][] = [];
    // Asymmetric retrieval models expect a query/passage hint; harmless for symmetric ones.
    const input = process.env.OPENROUTER_EMBED_PREFIX === "0" ? texts : texts.map((t) => (purpose === "query" ? `query: ${t}` : `passage: ${t}`));
    for (let i = 0; i < input.length; i += 32) {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ model: this.modelId, input: input.slice(i, i + 32) }),
          signal: AbortSignal.timeout(60000),
        });
        const j = (await res.json()) as any;
        if (res.ok && j.data) {
          for (const d of j.data.sort((a: any, b: any) => a.index - b.index)) out.push(d.embedding);
          break;
        }
        if (attempt >= 4 || res.status !== 429) throw new Error(`OpenRouter embeddings ${res.status}: ${j.error?.message ?? "error"}`);
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
    this.dim = out[0]?.length ?? 0;
    return out;
  }
}

export function embedderFor(model: string, dim: number): Embedder {
  if (model === "local-hash-v1") return new LocalHashEmbedder(dim);
  if (model.startsWith("openrouter:")) return new OpenRouterEmbedder(model.slice("openrouter:".length));
  return new NovaEmbedder(dim as 1024, model);
}

export function defaultEmbedder(): Embedder {
  if (process.env.SP_EMBEDDINGS === "nova") return new NovaEmbedder();
  if (process.env.SP_EMBEDDINGS === "openrouter") return new OpenRouterEmbedder();
  return new LocalHashEmbedder();
}
