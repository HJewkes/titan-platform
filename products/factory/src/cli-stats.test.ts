import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGateStore } from "@titan-design/hitl/sqlite";
import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { openFactoryHost } from "./host.js";
import { factoryRoutes, factoryWorkflows } from "./workflows.js";

function capture(): { out: string[]; err: string[]; io: Parameters<typeof runCli>[1] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: {} } };
}

describe("shepherd stats verb", () => {
  it("prints an empty report for a ledger with no runs", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const { out, io } = capture();

    const code = await runCli(["--db", db, "shepherd", "stats", "--json"], io);

    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ merges: [], ownerFriction: [], stageTimes: [], redAfterMerge: [], ownerOverrides: [] });
  });

  it("reports owner touches and the wait per gate kind from the gate store", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const store = openDatabase(db);
    let clock = Date.parse("2026-10-07T08:00:00Z");
    const gates = new SqliteGateStore(store, { migrate: false, now: () => clock });
    gates.create({ id: "run-1/approve-merge:0", prompt: "p" });
    clock += 3 * 3_600_000;
    gates.resolve("run-1/approve-merge:0", {}, { class: "owner-terminal", id: "owner", channel: "terminal" });
    store.close();
    const { out, io } = capture();

    const code = await runCli(["--db", db, "shepherd", "stats", "--json", "--from", "2026-10-07", "--to", "2026-10-07"], io);

    expect(code).toBe(0);
    expect(JSON.parse(out.join("")).ownerFriction).toEqual([{ day: "2026-10-07", ownerTouches: 1, kinds: [{ kind: "approve-merge", gates: 1, medianHours: 3, maxHours: 3 }] }]);
  });

  it("counts failed runs by class with --failures, reading a legacy unprefixed error by its text", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const store = openDatabase(db);
    const failed = (id: string, error: string): WorkflowRun => ({ id, workflowName: "shepherd-pr", params: { repo: "acme/widgets" }, status: "failed", currentStep: null, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: "2026-10-07T09:00:00.000Z", completedAt: "2026-10-07T10:00:00.000Z", error });
    new WorkflowRunStore(store).create(failed("run-1", "[land-rules] step land-rules (iteration 0) failed: refuses"));
    new WorkflowRunStore(store).create(failed("run-2", "step ci-wait:0 (iteration 0) failed: ci-wait timed out after 2700000 ms: waiting on check"));
    store.close();
    const { out, io } = capture();
    const human = capture();

    const code = await runCli(["--db", db, "shepherd", "stats", "--failures", "--json"], io);
    await runCli(["--db", db, "shepherd", "stats", "--failures"], human.io);

    expect(code).toBe(0);
    const report = JSON.parse(out.join(""));
    expect(Object.keys(report)).toEqual(["merges", "ownerFriction", "stageTimes", "redAfterMerge", "ownerOverrides", "failures"]);
    expect(report.failures).toEqual([
      { repo: "acme/widgets", week: "2026-W41", failures: 2, byClass: { "ci-timeout": 1, "gh-api-5xx": 0, "land-rules": 1, "update-branch": 0, other: 0 } },
    ]);
    expect(human.out.join("")).toContain("failures by class:\nacme/widgets  2026-W41  failed 2  ci-timeout 1  land-rules 1\n");
  });

  it("reports the merged runs whose main CI went red, with their PRs, in JSON and in the human report", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const store = openDatabase(db);
    for (const [pr, verdict] of [[1, "red"], [2, "green"]] as const) {
      const read = { stepId: "sh-main-ci", iteration: 0, agentId: null, signal: null, completedAt: "2026-10-07T09:00:00.000Z", data: { result: { verdict } } };
      const run = { id: `run-${pr}`, workflowName: "shepherd-pr", params: { repo: "acme/widgets", pr: String(pr) }, currentStep: null, activeSteps: {}, revision: 0, ownerGeneration: 0, error: null };
      new WorkflowRunStore(store).create({ ...run, status: "completed", stepResults: { "sh-main-ci:0": read }, startedAt: read.completedAt, completedAt: read.completedAt });
    }
    store.close();
    const json = capture();
    const human = capture();

    await runCli(["--db", db, "shepherd", "stats", "--json"], json.io);
    await runCli(["--db", db, "shepherd", "stats"], human.io);

    expect(JSON.parse(json.out.join("")).redAfterMerge).toEqual([{ repo: "acme/widgets", week: "2026-W41", merged: 2, red: 1, rate: 0.5, redPrs: [1], reverted: 0, revertedPrs: [] }]);
    expect(human.out.join("")).toContain("red after merge:\nacme/widgets  2026-W41  merged 2  red 1 (50.0%)  reverted 0\n");
  });

  it("refuses a malformed date", async () => {
    const { err, io } = capture();

    const code = await runCli(["--db", ":memory:", "shepherd", "stats", "--from", "yesterday"], io);

    expect(code).toBe(2);
    expect(err.join("")).toContain("YYYY-MM-DD");
  });

  it("prints one line and exits 2 when the store is missing", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "absent.db");
    const { err, io } = capture();

    const code = await runCli(["--db", db, "shepherd", "stats"], io);

    expect(code).toBe(2);
    expect(err.join("").trimEnd().split("\n")).toHaveLength(1);
    expect(err.join("")).toContain("cannot read the store");
  });
});
