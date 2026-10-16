/**
 * Open a title on the active player through the MCP tool surface (what an agent would call).
 *   npx tsx scripts/open-title.ts yt-soccer-aid-2023 [positionMs] [play]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [contentId, pos, play] = process.argv.slice(2);
if (!contentId) throw new Error("usage: open-title.ts <contentId> [positionMs] [play]");
const c = new Client({ name: "open-title", version: "0.1.0" });
await c.connect(new StreamableHTTPClientTransport(new URL(process.env.SP_MCP ?? "http://127.0.0.1:8787/mcp")));
const r = (await c.callTool({ name: "content.open", arguments: { contentId, ...(pos ? { positionMs: Number(pos) } : {}) } })) as { content: { text: string }[] };
console.log(r.content[0].text.slice(0, 300));
if (play) await c.callTool({ name: "player.play", arguments: {} });
await c.close();
