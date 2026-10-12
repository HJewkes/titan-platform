import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRICE_TABLE, PRICE_TABLE_VERSION } from "@titan-design/session-analytics";
import { openSessionGraph, syncPrices } from "@titan-design/session-graph";
import type { Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { DEFAULT_THROUGHPUT_INITIATIVES, resolveConfig } from "../config.js";

const INDEXED_AT = "2026-09-20T00:00:00.000Z";

let dir: string;
let graphFile: string;
let stateDir: string;
let initiativesRoot: string;
let offset = 0;

interface TaskFixture {
  id: string;
  status?: string;
  tags?: string[];
  estimate?: number;
  doneAt?: string | null;
}

function writeTask(initiative: string, task: TaskFixture): void {
  const tasksDir = path.join(initiativesRoot, initiative, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const lines = [`id: ${task.id}`, `title: ${task.id}`, "priority: 1", `status: ${task.status ?? "done"}`, "created: 2026-08-01", "updated: 2026-09-01"];
  lines.push(`done_at: ${task.doneAt === undefined ? "2026-09-02T00:00:00Z" : (task.doneAt ?? "null")}`);
  if (task.estimate !== undefined) lines.push(`estimate: ${task.estimate}`);
  if (task.tags) lines.push("tags:", ...task.tags.map((tag) => `  - "${tag}"`));
  writeFileSync(path.join(tasksDir, `${task.id}.yml`), `${lines.join("\n")}\n`);
}

/** An implementer session on the task: two calls ten minutes apart, starting at `start`. */
function addImplSession(db: Db, taskId: string, start: string): void {
  const sessionId = `impl-${taskId}`;
  db.prepare(
    `INSERT INTO session_origin (session_id, origin_system, depth, profile, task_ids, task_source, resolved_at)
     VALUES (?, 'agent-chat', 1, 'implementer', ?, 'name', '2026-09-01T00:00:00Z')`,
  ).run(sessionId, JSON.stringify([taskId]));
  const second = new Date(Date.parse(start) + 600_000).toISOString();
  for (const [ts, gap] of [[start, null], [second, 600_000]] as const) {
    offset += 1;
    db.prepare(
      `INSERT INTO request (transcript_id, request_id, byte_offset, session_id, ts, model, output_tokens, context_tokens, gap_ms)
       VALUES (1, ?, ?, ?, ?, 'claude-opus-5', 1000, 1000, ?)`,
    ).run(`req-${offset}`, offset, sessionId, ts, gap);
  }
}

function setIndexedAt(file: string, indexedAt: string): void {
  const graph = openSessionGraph(file);
  graph.transcripts.ensure("t1");
  graph.db.prepare("UPDATE transcript SET last_indexed_at = ? WHERE source_key = 't1'").run(indexedAt);
  graph.db.close();
}

/** A bare session graph, without the miner's own migrations, so a write path would show up as new tables. */
function seedGraph(file: string): void {
  const graph = openSessionGraph(file);
  syncPrices(graph, PRICE_TABLE, { tableVersion: PRICE_TABLE_VERSION, source: "fixture" });
  addImplSession(graph.db, "A-1", "2026-09-01T09:00:00Z");
  addImplSession(graph.db, "A-2", "2026-09-03T09:00:00Z");
  addImplSession(graph.db, "A-3", "2026-09-10T09:00:00Z");
  addImplSession(graph.db, "P-1", "2026-09-05T09:00:00Z");
  graph.db.close();
  setIndexedAt(file, INDEXED_AT);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-throughput-"));
  stateDir = path.join(dir, "state");
  initiativesRoot = path.join(dir, "initiatives");
  mkdirSync(stateDir);
  graphFile = path.join(dir, "graph.sqlite3");
  seedGraph(graphFile);
  writeTask("alpha", { id: "A-1", tags: ["kind:security"], estimate: 2, doneAt: "2026-09-02T00:00:00Z" });
  writeTask("alpha", { id: "A-2", tags: ["kind:feature"], estimate: 1, doneAt: "2026-09-04T00:00:00Z" });
  writeTask("alpha", { id: "A-3", tags: ["kind:feature"], estimate: 1, doneAt: "2026-09-11T00:00:00Z" });
  writeTask("alpha", { id: "A-4", status: "open", doneAt: null });
  writeFileSync(path.join(initiativesRoot, "alpha", "tasks", "broken.yml"), "id: [unclosed\n");
  writeTask("personal", { id: "P-1", tags: ["kind:feature"], doneAt: "2026-09-06T00:00:00Z" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ENV = () => ({ TITAN_MINER_INITIATIVES_ROOT: initiativesRoot, TITAN_MINER_THROUGHPUT_INITIATIVES: "alpha" });

async function cli(args: string[], root: string[] = ["--graph", graphFile]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io = { stdout: (t: string) => void (stdout += t), stderr: (t: string) => void (stderr += t), env: ENV() };
  const code = await runCli(["--state", stateDir, ...root, ...args], io);
  return { code, stdout, stderr };
}

async function json<T>(args: string[], root?: string[]): Promise<T> {
  const { code, stdout, stderr } = await cli(["--json", ...args], root);
  expect(code, stderr).toBe(0);
  return (JSON.parse(stdout) as { data: T }).data;
}

interface TableData {
  modelHash: string;
  watermark: { minerIndexedAt: string | null };
  rows: number;
  unparsed: { file: string }[];
  table: { classes: Record<string, { n: number }> };
}

describe("titan-miner throughput table", () => {
  it("reads only allowlisted initiatives' done tasks", async () => {
    const data = await json<TableData>(["throughput", "table", "--min-n", "0"]);

    expect(data.rows).toBe(3);
    expect(data.table.classes["feature/<=1"]?.n).toBe(2);
  });

  it("classes a task by its kind: tag", async () => {
    const data = await json<TableData>(["throughput", "table"]);

    expect(Object.keys(data.table.classes).sort()).toEqual(["feature/<=1", "security/2"]);
  });

  it("counts a malformed task file as unparsed instead of failing", async () => {
    const data = await json<TableData>(["throughput", "table"]);

    expect(data.unparsed.map((u) => u.file)).toEqual([path.join("alpha", "tasks", "broken.yml")]);
  });

  it("carries the miner watermark into the model hash", async () => {
    const before = await json<TableData>(["throughput", "table"]);
    setIndexedAt(graphFile, "2026-09-21T00:00:00.000Z");
    const after = await json<TableData>(["throughput", "table"]);

    expect(before.watermark.minerIndexedAt).toBe(INDEXED_AT);
    expect(after.modelHash).not.toBe(before.modelHash);
  });

  it("prints the model hash and watermark first in text", async () => {
    const { code, stdout } = await cli(["throughput", "table", "--min-n", "0"]);

    expect(code).toBe(0);
    expect(stdout).toMatch(new RegExp(`^model \\S+  watermark miner=${INDEXED_AT} newestDone=2026-09-11T00:00:00.000Z  initiatives=alpha  rows=3`));
    expect(stdout).toContain("security/2  n 1");
  });
});

describe("titan-miner throughput backtest", () => {
  it("scores the horizon after an origin and reports pooled and per-class coverage", async () => {
    const data = await json<{ modelHash: string; backtest: { pooled: { coverage: { n: number }; classes: Record<string, unknown> } } }>([
      "throughput", "backtest", "--origin", "2026-09-08", "--horizon", "7",
    ]);

    expect(data.modelHash).toMatch(/\S/);
    expect(data.backtest.pooled.coverage.n).toBe(1);
    expect(Object.keys(data.backtest.pooled.classes)).toEqual(["feature/<=1"]);
  });

  it("prints the model hash and watermark in text", async () => {
    const { code, stdout } = await cli(["throughput", "backtest", "--origin", "2026-09-08"]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/^model \S+ {2}watermark miner=/);
    expect(stdout).toContain("pooled implAgentHours 80% coverage");
  });
});

describe("throughput commands never write the graph", () => {
  it("leaves a --graph file byte-for-byte untouched", async () => {
    const before = statSync(graphFile);
    await cli(["throughput", "table"]);
    await cli(["throughput", "backtest", "--origin", "2026-09-08"]);

    const after = statSync(graphFile);
    expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size]);
  });

  it("opens the miner's own index read-only, so no miner migration runs on it", async () => {
    const own = resolveConfig({ stateDir }, {}).dbPath;
    seedGraph(own);
    const before = statSync(own);

    const { code, stderr } = await cli(["throughput", "table"], []);

    const graph = openSessionGraph(own, { readonly: true });
    const tables = graph.db.prepare("SELECT name FROM sqlite_master WHERE name = 'template'").all();
    graph.db.close();
    expect(code, stderr).toBe(0);
    expect(tables).toEqual([]);
    expect(statSync(own).mtimeMs).toBe(before.mtimeMs);
  });
});

describe("throughput initiative allowlist config", () => {
  it("defaults to the engineering initiatives when unset", () => {
    expect(resolveConfig({}, {}).throughputInitiatives).toEqual(DEFAULT_THROUGHPUT_INITIATIVES);
  });

  it("refuses a set but empty list rather than reading every initiative", () => {
    expect(() => resolveConfig({}, { TITAN_MINER_THROUGHPUT_INITIATIVES: " , " })).toThrow(/names no initiative/);
  });
});
