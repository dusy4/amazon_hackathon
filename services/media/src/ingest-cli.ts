import "dotenv/config";
import { ingest } from "./ingest.ts";

const args = process.argv.slice(2);
const contentId = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--transcribe") ?? "harbor-v-northgate";
const tIdx = args.indexOf("--transcribe");
const transcribe = tIdx >= 0 ? args[tIdx + 1] : undefined;

const { out, index } = await ingest(process.env.SP_DATA_DIR ?? "data", contentId, transcribe);
const counts = index.segments.reduce<Record<string, number>>((m, s) => ((m[s.kind] = (m[s.kind] ?? 0) + 1), m), {});
console.log(
  `indexed ${index.contentId}: ${index.segments.length} segments ${JSON.stringify(counts)}, ${index.entities.length} entities, ` +
    `embeddings=${index.embeddingModel}(${index.embeddingDim}), transcript=${index.sources.transcript} → ${out}`,
);
