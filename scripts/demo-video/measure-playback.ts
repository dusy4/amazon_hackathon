/**
 * How fast does the active player really play? Compares reported position to wall-clock time.
 *   npx tsx scripts/demo-video/measure-playback.ts [seconds]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const secs = Number(process.argv[2] ?? 10);
const c = new Client({ name: "measure", version: "0.1.0" });
await c.connect(new StreamableHTTPClientTransport(new URL(process.env.SP_MCP ?? "http://127.0.0.1:8787/mcp")));
const get = async () => JSON.parse(((await c.callTool({ name: "player.get_state", arguments: {} })) as { content: { text: string }[] }).content[0].text);
const a = await get();
const t = Date.now();
await new Promise((r) => setTimeout(r, secs * 1000));
const b = await get();
const wall = (Date.now() - t) / 1000;
console.log(`${b.deviceKind}: ${((b.positionMs - a.positionMs) / 1000).toFixed(2)} s of video in ${wall.toFixed(2)} s (${(((b.positionMs - a.positionMs) / 1000 / wall) * 100).toFixed(0)}% of real time)`);
await c.close();
