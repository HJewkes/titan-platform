import { describe, expect, it } from "vitest";
import { extractProtocolEdges, type GraphEdge, type GraphNode, type ProtocolEdge } from "@titan-design/code-graph";
import { emitRepoMap } from "./repo-map.js";
import type { MapLayout } from "./repo-map-types.js";
import type { GraphInput } from "./types.js";

// A made-up whiteboard-shaped repo: an app and an agent calling a review server's HTTP, SSE and MCP surfaces.
const SERVER = "packages/review/src/server.ts";
const MCP = "packages/review/src/review-api/mcp.ts";
const CLIENT = "packages/app/src/api-client.ts";
const LIVE = "packages/app/src/live.ts";
const AGENT = "packages/agent/src/agent-client.ts";
const SHARED = "packages/shared/src/types.ts";

const SOURCES = [
  { path: SERVER, text: 'app.get("/api/boards", h);\napp.get("/api/boards/:id", h);\napp.post("/api/boards", h);\napp.get("/api/events", (c) => streamSSE(c, s));\n' },
  { path: MCP, text: 'server.tool("list_boards", async () => fetch(`${base}/api/boards`));\n' },
  { path: CLIENT, text: 'fetch("/api/boards");\nfetch(`/api/boards/${id}`);\nfetch("/api/boards", { method: "POST" });\n' },
  { path: LIVE, text: 'new EventSource("/api/events");\n' },
  { path: AGENT, text: 'client.callTool({ name: "list_boards" });\n' },
];

const file = (id: string): GraphNode => ({ id, kind: "file", name: id.split("/").pop()!, role: "source" });
const imports = (srcId: string, dstId: string): GraphEdge => ({ srcId, dstId, kind: "imports" });

const whiteboard: GraphInput = {
  snapshotId: 1,
  nodes: [SERVER, MCP, CLIENT, LIVE, AGENT, SHARED].map(file),
  edges: [imports(CLIENT, SHARED), imports(SERVER, SHARED), imports(MCP, SERVER)],
};

const containerEdges = (map: MapLayout) => map.edges.filter((e) => e.level === 1);
const protocolArrows = (map: MapLayout) =>
  containerEdges(map)
    .filter((e) => e.edgeSource === "protocol")
    .map((e) => `${e.source} -> ${e.target} [${e.kind}] ${e.label}`);

describe("emitRepoMap protocol arrows on the whiteboard-shaped repo", () => {
  const protocolEdges = extractProtocolEdges(SOURCES).edges;

  it("draws one labelled one-way arrow per caller and server container, folding several endpoints", async () => {
    const map = await emitRepoMap(whiteboard, { protocolEdges });

    expect(protocolArrows(map)).toEqual([
      "pkg:agent -> pkg:review [mcp] MCP list_boards",
      "pkg:app -> pkg:review [http+sse] HTTP GET /api/boards +2 · SSE /api/events",
    ]);
  });

  it("routes every protocol arrow and gives it an id apart from the import arrow it may run beside", async () => {
    const map = await emitRepoMap(whiteboard, { protocolEdges });
    const ids = map.edges.map((e) => e.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const edge of containerEdges(map).filter((e) => e.edgeSource === "protocol")) {
      expect(edge.id).toBe(`protocol:${edge.source}->${edge.target}`);
      expect(edge.route?.length, `${edge.id} routed`).toBeGreaterThanOrEqual(2);
    }
  });

  it("leaves a call inside one container, or to a file not on the map, off the container map", async () => {
    const offMap: ProtocolEdge = { ...protocolEdges[0]!, srcId: "packages/gone/src/x.ts" };
    const map = await emitRepoMap(whiteboard, { protocolEdges: [...protocolEdges, offMap] });

    expect(protocolEdges.some((e) => e.srcId === MCP && e.dstId === SERVER)).toBe(true);
    expect(protocolArrows(map).some((a) => a.startsWith("pkg:review -> pkg:review"))).toBe(false);
    expect(protocolArrows(map)).toHaveLength(2);
    expect(map.nodes.some((n) => n.id.includes("gone"))).toBe(false);
  });

  it("labels the container import arrows imports only when no protocol arrow is drawn", async () => {
    const result = extractProtocolEdges([{ path: CLIENT, text: 'fetch("/api/boards");\n' }]);
    const map = await emitRepoMap(whiteboard, { protocolEdges: result.edges });
    const imported = containerEdges(map);

    expect(result.diagnostics.map((d) => d.code)).toEqual(["no-protocol-source"]);
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.map((e) => e.label)).toEqual(imported.map(() => "imports only"));
    expect(map.edges.filter((e) => e.level > 1).every((e) => e.label === undefined)).toBe(true);
  });

  it("leaves import arrows unlabelled when protocol arrows are drawn, and the map unchanged with no protocol input", async () => {
    const withProtocol = await emitRepoMap(whiteboard, { protocolEdges });
    const plain = await emitRepoMap(whiteboard);

    expect(withProtocol.edges.filter((e) => e.edgeSource !== "protocol").every((e) => e.label === undefined)).toBe(true);
    expect(plain.edges.every((e) => e.label === undefined && e.edgeSource !== "protocol")).toBe(true);
    expect(withProtocol.sha).not.toBe(plain.sha);
  });

  it("gives the same map whatever order the protocol edges arrive in", async () => {
    const first = await emitRepoMap(whiteboard, { protocolEdges });
    const reordered = await emitRepoMap(whiteboard, { protocolEdges: [...protocolEdges].reverse() });

    expect(reordered).toEqual(first);
  });
});
