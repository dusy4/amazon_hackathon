/**
 * Apply entity canonicalisation to a built index (merges caption mishearings into names Amazon
 * Rekognition recognised) and the commentary lead-in for goals.   npx tsx scripts/canonicalize-index.ts yt-soccer-aid-2023
 */
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalize } from "../services/media/src/canonicalize.ts";
import { applyLeadIn } from "../services/media/src/lead-in.ts";

const id = process.argv[2];
if (!id) throw new Error("usage: canonicalize-index.ts <contentId>");
const path = `data/index/${id}.json`;
const { index, merges } = canonicalize(JSON.parse(readFileSync(path, "utf8")));
for (const [from, to] of merges) console.log(`  ${from} → ${to}`);
console.log(`  lead-in applied to ${applyLeadIn(index)} goal/chance moments`);
writeFileSync(path, JSON.stringify(index));
console.log(`${id}: merged ${merges.size} caption-only names into recognised people`);
