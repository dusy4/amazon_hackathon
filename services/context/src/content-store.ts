import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentIndex, Entity } from "../../../packages/contracts/src/index.ts";

/** Loads pre-built content indices (data/index/*.json) produced by `npm run ingest`. */
export class ContentStore {
  private indices = new Map<string, ContentIndex>();
  constructor(private dataDir: string) {
    this.reload();
  }
  reload() {
    const dir = join(this.dataDir, "index");
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const idx: ContentIndex = JSON.parse(readFileSync(join(dir, f), "utf8"));
      this.indices.set(idx.contentId, idx);
    }
  }
  get(contentId: string | null | undefined): ContentIndex | undefined {
    return contentId ? this.indices.get(contentId) : undefined;
  }
  list() {
    return [...this.indices.values()];
  }
  mediaPath(idx: ContentIndex) {
    return join(this.dataDir, "content", idx.contentId, idx.media);
  }
  entity(idx: ContentIndex, id: string): Entity | undefined {
    return idx.entities.find((e) => e.id === id);
  }
}
