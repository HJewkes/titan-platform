const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

/**
 * A made-up whiteboard-shaped monorepo, as source text: a review server with HTTP routes and
 * one SSE stream, an MCP server whose tools call that HTTP API, a browser app, and an agent
 * that calls one MCP tool. The comment and the `Map#get` are not routes.
 */
export const WHITEBOARD_FILES: readonly { path: string; text: string }[] = [
  {
    path: "packages/review/src/server.ts",
    text: lines(
      'import { Hono } from "hono";',
      'import { streamSSE } from "hono/streaming";',
      "",
      "const app = new Hono();",
      '// app.get("/api/old-boards") was removed in the rewrite.',
      'app.get("/api/boards", (c) => c.json([]));',
      'app.post("/api/boards", (c) => c.json({ id: "b1" }));',
      'app.get("/api/boards/:id", (c) => c.json({ id: c.req.param("id") }));',
      'app.get("/api/events", (c) => streamSSE(c, async (stream) => stream.writeSSE({ data: "tick" })));',
      'const cache = new Map<string, string>();',
      'cache.get("/api/boards");',
      "export default app;",
    ),
  },
  {
    path: "packages/review/src/review-api/mcp.ts",
    text: lines(
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      "",
      "export function startMcp(base: string): McpServer {",
      '  const server = new McpServer({ name: "whiteboard", version: "1.0.0" });',
      '  server.tool("list_boards", async () => {',
      "    const res = await fetch(`${base}/api/boards`);",
      '    return { content: [{ type: "text", text: await res.text() }] };',
      "  });",
      '  server.registerTool("open_board", { description: "Open one board" }, async () => ({ content: [] }));',
      "  return server;",
      "}",
    ),
  },
  {
    path: "packages/app/src/api-client.ts",
    text: lines(
      "export const listBoards = () => fetch(\"/api/boards\");",
      "export const getBoard = (id: string) => fetch(`/api/boards/${id}?view=full`);",
      'export const createBoard = (body: string) => fetch("/api/boards", { method: "POST", body });',
    ),
  },
  {
    path: "packages/app/src/live.ts",
    text: lines('export const follow = () => new EventSource("/api/events");'),
  },
  {
    path: "packages/agent/src/agent-client.ts",
    text: lines(
      'import type { Client } from "@modelcontextprotocol/sdk/client/index.js";',
      "",
      'export const boards = (client: Client) => client.callTool({ name: "list_boards", arguments: {} });',
    ),
  },
];
