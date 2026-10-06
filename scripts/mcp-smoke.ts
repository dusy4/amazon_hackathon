/**
 * MCP smoke test against a running server: what any MCP client (e.g. an Alexa+-style agent) sees.
 *   npm start            (in another terminal)
 *   npm run smoke:mcp [-- http://host:8787/mcp]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] ?? "http://127.0.0.1:8787/mcp";
const client = new Client({ name: "semantic-playback-smoke", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
console.log(`connected to ${url} — server ${JSON.stringify(client.getServerVersion())}`);

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

const show = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  console.log(`\n${r.isError ? "✗" : "✓"} ${name} ${JSON.stringify(args)}\n${r.content[0].text.slice(0, 600)}`);
};
await show("lens.read_text", { atMs: 125000 });
await show("entities.resolve", { mention: "Northgate's number 9" });
await show("moments.search", { query: "Silva header", eventTypes: ["goal"], entityNames: ["Silva"], respectSpoilers: false, limit: 2 });
await show("moments.summarize", { fromMs: 80000, toMs: 125000 });
await client.close();
