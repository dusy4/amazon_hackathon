/**
 * Self-hosted MCP server over Streamable HTTP (MCP 2025-11-25), stateless mode.
 * This is the Alexa+-compatible tool surface; the built-in orchestrator is itself an MCP client of it.
 */
import type { Express, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppContext } from "./app-context.ts";
import { registerTools } from "./tools.ts";

export function createMcpServer(app: AppContext) {
  const server = new McpServer(
    { name: "semantic-playback", version: "0.1.0", title: "Semantic Playback" },
    {
      instructions:
        "Tools to control and understand what is playing on the user's TV. Ground references with moments.search / lens.* first, " +
        "then act with deterministic player.* primitives. Once a moment is grounded, compute relative seeks arithmetically.",
    },
  );
  registerTools(server, app);
  return server;
}

export function mountMcp(http: Express, app: AppContext, path = "/mcp") {
  http.post(path, async (req: Request, res: Response) => {
    const server = createMcpServer(app);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null });
    }
  });
  const notAllowed = (_req: Request, res: Response) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  http.get(path, notAllowed);
  http.delete(path, notAllowed);
}
