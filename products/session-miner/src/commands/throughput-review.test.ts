import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRICE_TABLE, PRICE_TABLE_VERSION } from "@titan-design/session-analytics";
import { openSessionGraph, syncPrices, type SessionGraph } from "@titan-design/session-graph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runCli } from "../cli.js";

interface TaskSpec {
  id: string;
  kind: string;
  start: string;
  doneAt: string;
  pr: number;
}

const TASKS: TaskSpec[] = [
  { id: "A-1", kind: "feature", start: "2026-09-01T09:00:00Z", doneAt: "2026-09-02T00:00:00Z", pr: 1 },
  { id: "A-2", kind: "docs", start: "2026-09-03T09:00:00Z", doneAt: "2026-09-04T00:00:00Z", pr: 2 },
  { id: "A-3", kind: "feature", start: "2026-09-05T09:00:00Z", doneAt: "2026-09-06T00:00:00Z", pr: 3 },
  { id: "A-4", kind: "feature", start: "2026-09-09T09:00:00Z", doneAt: "2026-09-10T00:00:00Z", pr: 4 },
  { id: "A-5", kind: "docs", start: "2026-09-10T09:00:00Z", doneAt: "2026-09-11T00:00:00Z", pr: 5 },
  { id: "A-6", kind: "feature", start: "2026-09-11T09:00:00Z", doneAt: "2026-09-12T00:00:00Z", pr: 6 },
];
const UNCACHED_PR = 6;
const REPO = "o/r";

let dir: string;
let stateDir: string;
let graphFile: string;
let initiativesRoot: string;
let offset = 0;

const prRefOf = (n: number): string => `pr:${REPO}#${n}`;

function writeTask(task: TaskSpec): void {
  const tasksDir = path.join(initiativesRoot, "alpha", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const lines = [`id: ${task.id}`, `title: ${task.id}`, "priority: 1", "status: done", "created: 2026-08-01", "updated: 2026-09-01"];
  lines.push(`done_at: ${task.doneAt}`, "estimate: 1", "tags:", `  - "kind:${task.kind}"`);
  writeFileSync(path.join(tasksDir, `${task.id}.yml`), `${lines.join("\n")}\n`);
}

/** An implementer session on the task, two calls ten minutes apart, linked to its merged PR. */
function addImplSession(graph: SessionGraph, task: TaskSpec): void {
  const sessionId = `impl-${task.id}`;
  graph.db
    .prepare(
      `INSERT INTO session_origin (session_id, origin_system, depth, profile, task_ids, task_source, resolved_at)
       VALUES (?, 'agent-chat', 1, 'implementer', ?, 'name', '2026-09-01T00:00:00Z')`,
    )
    .run(sessionId, JSON.stringify([task.id]));
  const second = new Date(Date.parse(task.start) + 600_000).toISOString();
  for (const [ts, gap] of [[task.start, null], [second, 600_000]] as const) {
    offset += 1;
    graph.db
      .prepare(
        `INSERT INTO request (transcript_id, request_id, byte_offset, session_id, ts, model, output_tokens, context_tokens, gap_ms)
         VALUES (1, ?, ?, ?, ?, 'claude-opus-5', 1000, 1000, ?)`,
      )
      .run(`req-${offset}`, offset, sessionId, ts, gap);
  }
  graph.db.prepare("INSERT OR IGNORE INTO pr (pr_ref, merged_at) VALUES (?, ?)").run(prRefOf(task.pr), task.doneAt);
  graph.edges.assert({ sourceRef: `session:${sessionId}`, relation: "linked", targetRef: prRefOf(task.pr) });
}

function seedGraph(file: string): void {
  const graph = openSessionGraph(file);
  syncPrices(graph, PRICE_TABLE, { tableVersion: PRICE_TABLE_VERSION, source: "fixture" });
  graph.transcripts.ensure("t1");
  for (const task of TASKS) addImplSession(graph, task);
  graph.db.close();
}

/** Feature PRs touch a migration, docs PRs only the site, so the two land in different review classes. */
function writeCache(): void {
  const prs = Object.fromEntries(
    TASKS.filter((task) => task.pr !== UNCACHED_PR).map((task) => {
      const filePath = task.kind === "docs" ? "site/guide.md" : "packages/x/migration/001.sql";
      const diff = { prRef: prRefOf(task.pr), repo: REPO, pr: task.pr, head: "a".repeat(40), files: [{ path: filePath, additions: 20, deletions: 1 }], truncated: false };
      return [prRefOf(task.pr), diff];
    }),
  );
  writeFileSync(path.join(stateDir, "pr-diffs.json"), `${JSON.stringify({ v: 1, prs })}\n`, { mode: 0o600 });
}

function writeShepherdRuns(file: string): void {
  const perRun = TASKS.slice(0, 2).map((task) => ({
    runId: `run-${task.id}`, task: `alpha/${task.id}`, repo: REPO, pr: task.pr, kind: task.kind, status: "completed",
    startedAt: task.start, completedAt: task.doneAt, stageMinutes: { ci: 6, review: 30, queued: 600 }, reviewRounds: 2, mergedAt: task.doneAt, mergePath: "shepherd",
  }));
  writeFileSync(file, JSON.stringify({ perRun }));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-throughput-review-"));
  stateDir = path.join(dir, "state");
  initiativesRoot = path.join(dir, "initiatives");
  mkdirSync(stateDir);
  graphFile = path.join(dir, "graph.sqlite3");
  seedGraph(graphFile);
  for (const task of TASKS) writeTask(task);
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

interface ArmData {
  n: number;
  pinball: { p50: number | null };
}

interface ReviewData {
  modelHash: string;
  cacheCoverage: { withPrs: number; featured: number };
  shepherdRuns: number | null;
  table: { key: string; targets: Record<string, { n: number; keys: Record<string, { n: number }> }> };
  ablation: { origins: { trainN: number; testN: number }[]; pooled: Record<string, { n: number; diff: ArmData; base: ArmData }> };
}

async function reviewJson(extra: string[] = []): Promise<ReviewData> {
  const { code, stdout, stderr } = await cli(["--json", "throughput", "review", "--origin", "2026-09-08", "--min-n", "0", ...extra]);
  expect(code, stderr).toBe(0);
  return z.object({ data: z.custom<ReviewData>() }).parse(JSON.parse(stdout)).data;
}

describe("titan-miner throughput review", () => {
  it("keys the table on review class x lead touch from the PR diff cache", async () => {
    writeCache();

    const data = await reviewJson();

    expect(data.table.key).toBe("diff");
    expect(Object.keys(data.table.targets.reviewAgentHours!.keys)).toEqual(["g10/migration", "standard/none"]);
  });

  it("scores both the diff arm and the kind x size-band arm on the same test rows", async () => {
    writeCache();

    const data = await reviewJson();

    const pooled = data.ablation.pooled.reviewAgentHours!;
    expect(data.ablation.origins).toEqual([expect.objectContaining({ trainN: 3, testN: 2 })]);
    expect([pooled.n, pooled.diff.n, pooled.base.n]).toEqual([2, 2, 2]);
    expect(pooled.diff.pinball.p50).not.toBeNull();
    expect(pooled.base.pinball.p50).not.toBeNull();
  });

  it("reports cache coverage over rows with a merged PR, counting an uncached PR as uncovered", async () => {
    writeCache();

    const data = await reviewJson();

    expect(data.cacheCoverage).toEqual({ withPrs: 6, featured: 5 });
    expect(data.shepherdRuns).toBeNull();
  });

  it("joins Shepherd runs so review rounds and post-PR hours carry values", async () => {
    writeCache();
    const runsFile = path.join(dir, "shepherd-runs.json");
    writeShepherdRuns(runsFile);

    const data = await reviewJson(["--shepherd-runs", runsFile]);

    expect(data.shepherdRuns).toBe(2);
    expect(data.table.targets.reviewRounds!.n).toBe(2);
    expect(data.table.targets.postPrWallHours!.n).toBe(2);
  });

  it("refuses with a pointer to the backfill when no PR diff cache exists", async () => {
    const { code, stderr } = await cli(["throughput", "review", "--origin", "2026-09-08"]);

    expect(code).not.toBe(0);
    expect(stderr).toContain("run throughput pr-backfill");
  });

  it("prints the model hash, cache coverage, table and per-target ablation in text", async () => {
    writeCache();

    const { code, stdout, stderr } = await cli(["throughput", "review", "--origin", "2026-09-08", "--min-n", "0"]);

    expect(code, stderr).toBe(0);
    expect(stdout).toMatch(/^model \S+ {2}watermark miner=/);
    expect(stdout).toContain("cache coverage 5/6 83%");
    expect(stdout).toMatch(/g10\/migration {2}reviewAgentHours n 3 from key:g10\/migration/);
    expect(stdout).toMatch(/reviewAgentHours {2}n 2 .*insufficient {2}diff pinball p10 .* base pinball p10/);
  });
});
