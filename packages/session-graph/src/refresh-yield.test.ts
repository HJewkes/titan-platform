import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredTranscript } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import { indexTranscript, refreshCorpus } from "./refresh.js";

const EXCHANGES = 400;

function exchange(sessionId: string, n: number): unknown[] {
  const ts = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n * 3 + s)).toISOString();
  const common = { sessionId, cwd: "/synthetic", gitBranch: "main" };
  const toolUse = { type: "tool_use", id: `t-${sessionId}-${n}`, name: "Edit", input: { file_path: `/synthetic/f${n % 7}.ts` } };
  return [
    { ...common, type: "user", uuid: `u-${sessionId}-${n}`, timestamp: ts(0), message: { role: "user", content: `prompt ${n}` } },
    { ...common, type: "assistant", uuid: `a-${sessionId}-${n}`, timestamp: ts(1), requestId: `req-${sessionId}-${n}`, message: { id: `m-${sessionId}-${n}`, role: "assistant", model: "m", usage: { input_tokens: 3, output_tokens: 2 }, content: [toolUse] } },
    { ...common, type: "user", timestamp: ts(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "ok" }] } },
  ];
}

let dir: string;
let graphs: SessionGraph[];

function writeTranscript(sessionId: string, exchanges: number): DiscoveredTranscript {
  const absolutePath = path.join(dir, `${sessionId}.jsonl`);
  const lines = Array.from({ length: exchanges }, (_, n) => exchange(sessionId, n)).flat();
  writeFileSync(absolutePath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null, account: null };
}

function openGraph(): SessionGraph {
  const graph = openSessionGraph(":memory:");
  graphs.push(graph);
  return graph;
}

const CLOCK_COLUMNS = new Set(["t_indexed", "t_created", "applied_at", "last_indexed_at", "created_at"]);

/** Every table, rows in rowid order, minus the wall-clock audit columns that differ between passes by construction. */
function dumpAll(graph: SessionGraph): Record<string, string> {
  const tables = graph.db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  const strip = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !CLOCK_COLUMNS.has(key)));
  const rows = (name: string) => graph.db.prepare<[], Record<string, unknown>>(`SELECT * FROM "${name}"`).all();
  return Object.fromEntries(tables.map(({ name }) => [name, JSON.stringify(rows(name).map(strip))]));
}

const count = (graph: SessionGraph, sql: string) => graph.db.prepare<[], { n: number }>(sql).get()?.n;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-yield-"));
  graphs = [];
});
afterEach(() => {
  for (const graph of graphs) graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("refreshCorpus with a yieldPoint (TP-4175)", () => {
  it("leaves the same graph as a pass that never yields", async () => {
    const transcripts = [writeTranscript("big", EXCHANGES), writeTranscript("small", 3)];
    const plain = openGraph();
    const yielding = openGraph();
    let yields = 0;

    await refreshCorpus(plain, transcripts, { full: true });
    await refreshCorpus(yielding, transcripts, { full: true, yieldPoint: async () => void (yields += 1) });

    expect(dumpAll(yielding)).toEqual(dumpAll(plain));
    expect(count(plain, "SELECT COUNT(*) AS n FROM fact")).toBeGreaterThan(1_000);
    expect(yields).toBeGreaterThan(0);
  });

  it("yields between bounded steps inside one transcript's delta", async () => {
    const graph = openGraph();
    const factsAtYield: number[] = [];

    await indexTranscript(graph, writeTranscript("big", EXCHANGES), {
      yieldPoint: async () => void factsAtYield.push(count(graph, "SELECT COUNT(*) AS n FROM fact")),
    });

    const total = count(graph, "SELECT COUNT(*) AS n FROM fact");
    expect(new Set(factsAtYield.filter((n) => n < total)).size).toBeGreaterThanOrEqual(2);
  });

  it("rolls a delta back whole when its yield throws, leaving the watermark where it was", async () => {
    const graph = openGraph();
    const transcript = writeTranscript("big", EXCHANGES);
    let calls = 0;
    const abort = async () => {
      calls += 1;
      if (calls === 2) throw new Error("shutdown");
    };

    await expect(indexTranscript(graph, transcript, { yieldPoint: abort })).rejects.toThrow("shutdown");

    expect(graph.db.inTransaction).toBe(false);
    expect(count(graph, "SELECT COUNT(*) AS n FROM fact")).toBe(0);
    expect(graph.transcripts.get(transcript.displayPath)?.lastOffset).toBe(0);
  });

  it("yields between sessions of the rollup and finishes every session when that yield throws", async () => {
    const graph = openGraph();
    const transcripts = ["a", "b", "c"].map((id) => writeTranscript(id, 2));
    const ended = () => count(graph, "SELECT COUNT(*) AS n FROM turn WHERE ended_at IS NOT NULL");
    const abortMidRollup = async () => {
      const n = ended();
      if (n > 0 && n < 6) throw new Error("shutdown");
    };

    await expect(refreshCorpus(graph, transcripts, { yieldPoint: abortMidRollup })).rejects.toThrow("shutdown");

    expect(count(graph, "SELECT COUNT(*) AS n FROM turn WHERE ended_at IS NULL")).toBe(0);
    expect(ended()).toBe(6);
  });
});
