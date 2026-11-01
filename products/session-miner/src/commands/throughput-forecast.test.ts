import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRICE_TABLE, PRICE_TABLE_VERSION } from "@titan-design/session-analytics";
import { openSessionGraph, syncPrices } from "@titan-design/session-graph";
import type { Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runCli } from "../cli.js";

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
}

function writeTask(initiative: string, task: TaskFixture): void {
  const tasksDir = path.join(initiativesRoot, initiative, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const status = task.status ?? "done";
  const lines = [`id: ${task.id}`, `title: ${task.id}`, "priority: 1", `status: ${status}`, "created: 2026-08-01", "updated: 2026-09-01"];
  lines.push(`done_at: ${status === "done" ? "2026-09-02T00:00:00Z" : "null"}`);
  if (task.estimate !== undefined) lines.push(`estimate: ${task.estimate}`);
  if (task.tags) lines.push("tags:", ...task.tags.map((tag) => `  - "${tag}"`));
  writeFileSync(path.join(tasksDir, `${task.id}.yml`), `${lines.join("\n")}\n`);
}

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

function seedGraph(file: string): void {
  const graph = openSessionGraph(file);
  syncPrices(graph, PRICE_TABLE, { tableVersion: PRICE_TABLE_VERSION, source: "fixture" });
  addImplSession(graph.db, "A-1", "2026-09-01T09:00:00Z");
  addImplSession(graph.db, "A-2", "2026-09-03T09:00:00Z");
  addImplSession(graph.db, "A-3", "2026-09-10T09:00:00Z");
  graph.transcripts.ensure("t1");
  graph.db.prepare("UPDATE transcript SET last_indexed_at = ? WHERE source_key = 't1'").run("2026-09-20T00:00:00.000Z");
  graph.db.close();
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-forecast-"));
  stateDir = path.join(dir, "state");
  initiativesRoot = path.join(dir, "initiatives");
  mkdirSync(stateDir);
  graphFile = path.join(dir, "graph.sqlite3");
  seedGraph(graphFile);
  writeTask("alpha", { id: "A-1", tags: ["kind:security"], estimate: 2 });
  writeTask("alpha", { id: "A-2", tags: ["kind:feature"], estimate: 1 });
  writeTask("alpha", { id: "A-3", tags: ["kind:feature"], estimate: 1 });
  writeTask("alpha", { id: "B-1", status: "open", tags: ["kind:feature", "milestone:M1"], estimate: 1 });
  writeTask("alpha", { id: "B-2", status: "open", tags: ["kind:novel", "parent:B-9"], estimate: 1 });
  writeTask("alpha", { id: "B-3", status: "open", tags: ["kind:security", "parent:B-9"], estimate: 2 });
  writeTask("alpha", { id: "B-9", status: "open", tags: ["kind:feature"], estimate: 3 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const env = { TITAN_MINER_INITIATIVES_ROOT: initiativesRoot, TITAN_MINER_THROUGHPUT_INITIATIVES: "alpha" };
  const io = { stdout: (t: string) => void (stdout += t), stderr: (t: string) => void (stderr += t), env };
  const code = await runCli(["--state", stateDir, "--graph", graphFile, ...args], io);
  return { code, stdout, stderr };
}

const Quantiles = z.object({ p10: z.number(), p50: z.number(), p80: z.number(), p90: z.number() });
const Forecast = z.object({
  modelHash: z.string(),
  forecast: z.object({
    forecastHash: z.string(),
    weekEffect: z.string(),
    totals: z.object({ implAgentHours: Quantiles, reviewAgentHours: Quantiles, usd: Quantiles }),
    tasks: z.array(z.object({ taskId: z.string(), closureRate: z.number().nullable() })),
    unclassifiable: z.array(z.object({ taskId: z.string() })),
  }),
  notFound: z.array(z.string()),
  skippedDone: z.array(z.string()),
});

async function forecast(args: string[]): Promise<z.infer<typeof Forecast>> {
  const { code, stdout, stderr } = await cli(["--json", "throughput", "forecast", ...args]);
  expect(code, stderr).toBe(0);
  return Forecast.parse(z.object({ data: z.unknown() }).parse(JSON.parse(stdout)).data);
}

describe("titan-miner throughput forecast", () => {
  it("orders p10 through p90 for implementer hours, reviewer hours and USD", async () => {
    const { forecast: f } = await forecast(["--tasks", "B-1,B-3"]);

    for (const q of Object.values(f.totals)) {
      expect(q.p10).toBeLessThanOrEqual(q.p50);
      expect(q.p50).toBeLessThanOrEqual(q.p80);
      expect(q.p80).toBeLessThanOrEqual(q.p90);
    }
    expect(f.totals.implAgentHours.p90).toBeGreaterThan(0);
  });

  it("reports the same inputs twice and a new forecast hash for another seed", async () => {
    const first = await forecast(["--tasks", "B-1,B-3"]);
    const again = await forecast(["--tasks", "B-1,B-3"]);
    const other = await forecast(["--tasks", "B-1,B-3", "--seed", "other"]);

    expect(again).toEqual(first);
    expect(other.forecast.forecastHash).not.toBe(first.forecast.forecastHash);
    expect(other.modelHash).toBe(first.modelHash);
  });

  it("selects open descendants with --parent and tagged tasks with --milestone", async () => {
    const parent = await forecast(["--parent", "B-9"]);
    const milestone = await forecast(["--milestone", "M1"]);

    expect(parent.forecast.tasks.map((t) => t.taskId)).toEqual(["B-2", "B-3"]);
    expect(milestone.forecast.tasks.map((t) => t.taskId)).toEqual(["B-1"]);
  });

  it("keeps an unclassifiable task in the set and lists it", async () => {
    const data = await forecast(["--tasks", "B-2,B-3"]);
    const { stdout } = await cli(["throughput", "forecast", "--tasks", "B-2,B-3"]);

    expect(data.forecast.unclassifiable.map((t) => t.taskId)).toEqual(["B-2"]);
    expect(data.forecast.tasks.map((t) => t.taskId)).toEqual(["B-2", "B-3"]);
    expect(stdout).toContain("unclassifiable: B-2");
  });

  it("lists unknown and done ids instead of forecasting them", async () => {
    const data = await forecast(["--tasks", "B-1,A-1,Z-1"]);

    expect(data.notFound).toEqual(["Z-1"]);
    expect(data.skippedDone).toEqual(["A-1"]);
    expect(data.forecast.tasks.map((t) => t.taskId)).toEqual(["B-1"]);
  });

  it("honours --week-effect off and --closure off", async () => {
    const data = await forecast(["--tasks", "B-1", "--week-effect", "off", "--closure", "off"]);

    expect(data.forecast.weekEffect).toBe("off");
    expect(data.forecast.tasks.map((t) => t.closureRate)).toEqual([null]);
  });

  it("prints the totals and a task line in text", async () => {
    const { code, stdout } = await cli(["throughput", "forecast", "--tasks", "B-1"]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/^model \S+/);
    expect(stdout).toMatch(/impl h {2}\s*p10 [\d.]+ p50 [\d.]+ p80 [\d.]+ p90 [\d.]+/);
    expect(stdout).toMatch(/^B-1 {2}feature\/<=1 {2}from \S+ {2}n \d+ {2}close /m);
  });

  it("fails with no data when every selected task is done or missing", async () => {
    const { code, stderr } = await cli(["throughput", "forecast", "--tasks", "A-1,Z-1"]);

    expect(code).not.toBe(0);
    expect(stderr).toContain("no open task selected");
  });

  it("requires exactly one selector", async () => {
    const none = await cli(["throughput", "forecast"]);
    const two = await cli(["throughput", "forecast", "--tasks", "B-1", "--parent", "B-9"]);

    expect(none.code).not.toBe(0);
    expect(two.code).not.toBe(0);
    expect(two.stderr).toContain("exactly one of");
  });

  it("leaves the graph file untouched", async () => {
    const before = statSync(graphFile);
    await cli(["throughput", "forecast", "--tasks", "B-1"]);

    const after = statSync(graphFile);
    expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size]);
  });
});
