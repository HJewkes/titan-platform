import { describe, expect, it } from "vitest";
import { WHITEBOARD_FILES } from "./protocol-edges.fixture.js";
import { NO_PROTOCOL_SOURCE, extractProtocolEdges, type ProtocolEdge } from "./protocol-edges.js";

const SERVER = "packages/review/src/server.ts";
const MCP = "packages/review/src/review-api/mcp.ts";
const CLIENT = "packages/app/src/api-client.ts";

const file = (path: string, text: string) => ({ path, text });
const arrows = (edges: readonly ProtocolEdge[]): string[] => edges.map((e) => `${e.srcId} -> ${e.dstId} ${e.label}`);

describe("extractProtocolEdges over the whiteboard fixture", () => {
  const result = extractProtocolEdges(WHITEBOARD_FILES);

  it("finds every HTTP route, SSE stream and MCP tool the servers declare, and nothing in comments or Map#get", () => {
    expect(result.endpoints.map((e) => `${e.kind} ${e.name} ${e.fileId}:${e.line}`)).toEqual([
      `http GET /api/boards ${SERVER}:6`,
      `http GET /api/boards/:id ${SERVER}:8`,
      `http POST /api/boards ${SERVER}:7`,
      `mcp list_boards ${MCP}:5`,
      `mcp open_board ${MCP}:9`,
      `sse GET /api/events ${SERVER}:9`,
    ]);
  });

  it("draws one labelled edge from each caller file to the file serving what it calls", () => {
    expect(arrows(result.edges)).toEqual([
      `packages/agent/src/agent-client.ts -> ${MCP} MCP list_boards`,
      `${CLIENT} -> ${SERVER} HTTP GET /api/boards`,
      `${CLIENT} -> ${SERVER} HTTP GET /api/boards/:id`,
      `${CLIENT} -> ${SERVER} HTTP POST /api/boards`,
      `packages/app/src/live.ts -> ${SERVER} SSE /api/events`,
      `${MCP} -> ${SERVER} HTTP GET /api/boards`,
    ]);
  });

  it("records the caller's line and the edge kind", () => {
    const sse = result.edges.find((e) => e.kind === "sse");
    expect(sse).toMatchObject({ srcId: "packages/app/src/live.ts", line: 1, endpoint: "GET /api/events" });
    expect(result.edges.find((e) => e.label === "HTTP POST /api/boards")?.line).toBe(3);
  });

  it("reports no diagnostic when a protocol source exists", () => {
    expect(result.diagnostics).toEqual([]);
  });
});

describe("extractProtocolEdges", () => {
  it("names the no-protocol-source diagnostic when no file declares a route, tool or stream", () => {
    const result = extractProtocolEdges([file("src/a.ts", 'import { b } from "./b";\nfetch("/api/x");\n')]);

    expect(result.endpoints).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.diagnostics).toEqual([{ code: NO_PROTOCOL_SOURCE, message: expect.stringContaining("imports only") }]);
  });

  it("matches a call that reaches a route through a mounted prefix, but not a bare parameter route", () => {
    const result = extractProtocolEdges([
      file("api/routes.ts", 'router.get("/notes/:id", h);\nrouter.get("/:slug", h);\n'),
      file("web/client.ts", "fetch(`${BASE}/v1/notes/${id}`);\n"),
    ]);

    expect(arrows(result.edges)).toEqual(["web/client.ts -> api/routes.ts HTTP GET /notes/:id"]);
  });

  it("matches the method: a POST call skips a GET route, an unknown method matches any, and all matches every call", () => {
    const result = extractProtocolEdges([
      file("api/routes.ts", 'app.get("/a", h);\napp.all("/b", h);\n'),
      file("web/post.ts", 'fetch("/a", { method: "POST" });\nfetch("/b", { method: "put" });\n'),
      file("web/any.ts", 'fetch("/a", { method: verb });\n'),
    ]);

    expect(arrows(result.edges)).toEqual([
      "web/any.ts -> api/routes.ts HTTP GET /a",
      "web/post.ts -> api/routes.ts HTTP ALL /b",
    ]);
  });

  it("keeps one edge per caller, server and endpoint when a file calls the same route twice", () => {
    const result = extractProtocolEdges([
      file("api/routes.ts", 'app.get("/a", h);\n'),
      file("web/client.ts", 'fetch("/a");\nfetch("/a/");\n'),
    ]);

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.line).toBe(1);
  });

  it("marks a route as SSE when its handler sets text/event-stream, and links an EventSource only to SSE routes", () => {
    const result = extractProtocolEdges([
      file("api/stream.ts", 'app.get("/feed", (c) => c.body(s, 200, { "Content-Type": "text/event-stream" }));\napp.get("/plain", h);\n'),
      file("web/live.ts", 'new EventSource("/feed");\nnew EventSource("/plain");\n'),
    ]);

    expect(result.endpoints.map((e) => `${e.kind} ${e.name}`)).toEqual(["http GET /plain", "sse GET /feed"]);
    expect(arrows(result.edges)).toEqual(["web/live.ts -> api/stream.ts SSE /feed"]);
  });

  it("links callTool by name in either argument form and ignores non-literal names and unknown tools", () => {
    const result = extractProtocolEdges([
      file("mcp/server.ts", 'server.tool("search", h);\nserver.registerTool("fetch_page", spec, h);\n'),
      file("agent/a.ts", 'client.callTool({ name: "search" });\nclient.callTool("fetch_page");\nclient.callTool({ name: tool });\nclient.callTool({ name: "nope" });\n'),
    ]);

    expect(arrows(result.edges)).toEqual([
      "agent/a.ts -> mcp/server.ts MCP fetch_page",
      "agent/a.ts -> mcp/server.ts MCP search",
    ]);
  });

  it("skips non-script files and a server calling its own route", () => {
    const result = extractProtocolEdges([
      file("api/routes.ts", 'app.get("/a", h);\nfetch("/a");\n'),
      file("docs/readme.md", 'fetch("/a")\n'),
    ]);

    expect(result.endpoints).toHaveLength(1);
    expect(result.edges).toEqual([]);
  });

  it("returns the same result whatever the file order", () => {
    expect(extractProtocolEdges([...WHITEBOARD_FILES].reverse())).toEqual(extractProtocolEdges(WHITEBOARD_FILES));
  });
});
