import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGateStore } from "@titan-design/hitl/sqlite";
import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { OWNER_GATE_POLICY } from "./shepherd/policy.js";
import { ShepherdStore } from "./shepherd/store.js";
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
    expect(JSON.parse(out.join(""))).toEqual({ merges: [], ownerFriction: [], stageTimes: [], redAfterMerge: [], ownerOverrides: [], reviewCauses: [] });
  });

  it("prints one record per run with --per-run --json, its kind read from the registration", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const store = openDatabase(db);
    const merge = { stepId: "merge", iteration: 0, agentId: null, signal: null, completedAt: "2026-10-07T09:30:00.000Z", data: { result: { done: true } } };
    new WorkflowRunStore(store).create({ id: "run-1", workflowName: "shepherd-pr", params: { repo: "acme/widgets", pr: "3", task: "demo/T-9" }, status: "completed", currentStep: null, stepResults: { "merge:0": merge }, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: "2026-10-07T09:00:00.000Z", completedAt: "2026-10-07T09:31:00.000Z", error: null });
    new ShepherdStore(store).register({ repo: "acme/widgets", pr: 3, runId: "run-1", task: "demo/T-9", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "refactor" });
    store.close();
    const { out, io } = capture();

    const code = await runCli(["--db", db, "shepherd", "stats", "--per-run", "--json"], io);

    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({
      perRun: [{ runId: "run-1", task: "demo/T-9", repo: "acme/widgets", pr: 3, kind: "refactor", status: "completed", startedAt: "2026-10-07T09:00:00.000Z", completedAt: "2026-10-07T09:31:00.000Z", stageMinutes: { land: 30 }, reviewRounds: 0, mergedAt: "2026-10-07T09:30:00.000Z", mergePath: "shepherd" }],
    });
  });

  it("reports merge-up classes, strict rounds, slow owner-gated merges and foreign merge-ups in JSON and in the text line", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const store = openDatabase(db);
    const result = (stepId: string, completedAt: string, data: Record<string, unknown>) => ({ [stepId]: { stepId, iteration: 0, agentId: null, signal: null, completedAt, data: { result: data } } });
    const stepResults = {
      ...result("land-rules", "2026-10-07T08:59:00.000Z", { base: "main", contexts: [], strict: true }),
      ...result("sh-await-verdict:h1", "2026-10-07T09:00:00.000Z", { kind: "verdict", verdict: "MERGE" }),
      ...result("ci-wait:0", "2026-10-07T09:01:00.000Z", { verdict: "behind", headSha: "h1", baseMoved: true }),
      ...result("update-branch:0", "2026-10-07T09:02:00.000Z", { headSha: "h2", own: true }),
      ...result("approve-merge:0", "2026-10-07T10:20:00.000Z", { approved: true }),
      ...result("merge:0", "2026-10-07T10:30:00.000Z", { done: true }),
    };
    new WorkflowRunStore(store).create({ id: "run-1", workflowName: "shepherd-pr", params: { repo: "acme/widgets", pr: "3" }, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: "2026-10-07T08:58:00.000Z", completedAt: "2026-10-07T10:31:00.000Z", error: null });
    store.close();
    const json = capture();
    const text = capture();

    await runCli(["--db", db, "shepherd", "stats", "--json"], json.io);
    await runCli(["--db", db, "shepherd", "stats"], text.io);

    expect(JSON.parse(json.out.join("")).merges[0]).toMatchObject({ mergeUps: { landTime: 1, strictChase: 0, freezeHold: 0, retry: 0 }, strictRounds: 1, slowOwnerGated: 1, foreignMergeUps: 0 });
    expect(text.out.join("")).toContain("slow owner-gated 1  outside Shepherd 0  merge-ups land/strict/freeze/retry 1/0/0/0  strict rounds 1  foreign merge-ups 0\n");
  });

  it("refuses --per-run without --json", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const { out, err, io } = capture();

    const code = await runCli(["--db", db, "shepherd", "stats", "--per-run"], io);

    expect([code, out, err.join("")]).toEqual([2, [], "error: --per-run prints JSON only; add --json\n"]);
  });

  it("prints only the review causes with --rereviews", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const json = capture();
    const text = capture();

    const codes = [await runCli(["--db", db, "shepherd", "stats", "--rereviews", "--json"], json.io), await runCli(["--db", db, "shepherd", "stats", "--rereviews"], text.io)];

    expect(codes).toEqual([0, 0]);
    expect(JSON.parse(json.out.join(""))).toEqual({ reviewCauses: [] });
    expect(text.out.join("")).toBe("no reviews in range\n");
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

  it("meters gates per policy row and resolver over --since with --gates --json", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const store = openDatabase(db);
    let clock = Date.now() - 3 * 3_600_000;
    const gates = new SqliteGateStore(store, { migrate: false, now: () => clock });
    gates.create({ id: "run-1/approve-merge:0", prompt: "Merge? Policy authority/MRG-AU: owner merges" });
    gates.create({ id: "run-2/approve-merge:0", prompt: "Merge? Policy authority/MRG-AU: owner merges" });
    clock += 2 * 3_600_000;
    gates.resolve("run-1/approve-merge:0", { decision: "merge" }, { class: "owner-terminal", id: "owner", channel: "terminal" });
    store.close();
    const { out, io } = capture();

    const code = await runCli(["--db", db, "shepherd", "stats", "--gates", "--since", "7d", "--json"], io);

    expect(code).toBe(0);
    const rows = JSON.parse(out.join("")).gates;
    expect(rows.map((row: { resolver: string; decisions: object; pending: number }) => [row.resolver, row.decisions, row.pending])).toEqual([
      ["owner-terminal", { merge: 1 }, 0],
      ["unanswered", {}, 1],
    ]);
    expect(rows[0]).toMatchObject({ policyRow: "authority/MRG-AU", count: 1, medianHours: 2, maxHours: 2 });
  });

  it.each([
    [["--since", "7d"], "--since applies only to --gates"],
    [["--gates"], "--gates needs --since"],
    [["--gates", "--since", "7d", "--from", "2026-10-01"], "--gates takes --since, not --from/--to"],
    [["--gates", "--since", "7x"], "--since expects a window like 90m, 6h or 2d"],
  ])("refuses %j as a usage error", async (args, message) => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const { err, io } = capture();

    const code = await runCli(["--db", db, "shepherd", "stats", ...args], io);

    expect(code).toBe(2);
    expect(err.join("")).toContain(message);
  });

  it("prints the review cost section alone under --cost", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const { out, io } = capture();

    const code = await runCli(["--db", db, "shepherd", "stats", "--cost", "--json"], io);

    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ reviewCost: { prs: [], weeks: [], totals: { prs: 0, completePrs: 0, usd: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, unreadable: 0, p50Usd: null, p90Usd: null } } });
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
    expect(Object.keys(report)).toEqual(["merges", "ownerFriction", "stageTimes", "redAfterMerge", "ownerOverrides", "failures", "reviewCauses"]);
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

  it("reports review causes beside red-after-merge, in JSON and in the human report", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "stats-")), "factory.db");
    openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const store = openDatabase(db);
    const at = "2026-10-07T09:00:00.000Z";
    const intent = { stepId: "sh-review-intent:abc", iteration: 0, agentId: null, signal: null, completedAt: at, data: { result: { kind: "intent", head: "abc", reviewer: "rv", at: 0, mode: "spawn", cause: { cause: "first" } } } };
    const mainCi = { stepId: "sh-main-ci", iteration: 0, agentId: null, signal: null, completedAt: at, data: { result: { verdict: "red" } } };
    const run = { id: "run-1", workflowName: "shepherd-pr", params: { repo: "acme/widgets", pr: "1" }, currentStep: null, activeSteps: {}, revision: 0, ownerGeneration: 0, error: null };
    new WorkflowRunStore(store).create({ ...run, status: "completed", stepResults: { "sh-review-intent:abc:0": intent, "sh-main-ci:0": mainCi }, startedAt: at, completedAt: at });
    store.close();
    const json = capture();
    const human = capture();

    await runCli(["--db", db, "shepherd", "stats", "--json"], json.io);
    await runCli(["--db", db, "shepherd", "stats"], human.io);
    const report = JSON.parse(json.out.join(""));

    expect(report.redAfterMerge).toHaveLength(1);
    expect(report.reviewCauses).toEqual([{ repo: "acme/widgets", week: "2026-W41", reviews: 1, causes: { first: 1 } }]);
    expect(human.out.join("")).toContain("red after merge:");
    expect(human.out.join("")).toContain("review causes:\nacme/widgets  2026-W41  reviews 1\n  first  1\n");
  });

  describe("--slo", () => {
    const REGISTRY = {
      schema: "titan.metrics/v1",
      area: "shepherd",
      owner: "seat",
      stores: [{ id: "shepherd-stats", kind: "cli", readonly: true }],
      metrics: [
        {
          id: "shepherd.business.merges_per_day",
          family: "business",
          title: "Merges per day",
          definition: "Shepherd merges per UTC day",
          unit: "count",
          source: { anchor: "a.ts#a", store: "ledger", captured: "Y" },
          query: { kind: "cli", store: "shepherd-stats", text: "business.merges-per-day" },
          cadence: "1d",
          slo: { objective: "at least 1 a day", target: 1, op: ">=", window: "7d", alert: { threshold: 1, sustain: 1 } },
          surfaces: ["stats"],
          answers: [4],
        },
      ],
      reports: [],
      lastAudit: { at: "2026-10-08T00:00:00Z", codeRev: "0000000", report: "audit.md" },
    };

    function ledgerWithOneMerge(dir: string): string {
      const db = join(dir, "factory.db");
      openFactoryHost({ dbPath: db, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
      const store = openDatabase(db);
      const at = "2026-10-07T09:00:00.000Z";
      const merge = { stepId: "merge", iteration: 0, agentId: null, signal: null, completedAt: at, data: { result: { done: true } } };
      new WorkflowRunStore(store).create({ id: "run-1", workflowName: "shepherd-pr", params: { repo: "acme/widgets", pr: "1" }, currentStep: null, activeSteps: {}, revision: 0, ownerGeneration: 0, error: null, status: "completed", stepResults: { "merge:0": merge }, startedAt: at, completedAt: at });
      store.close();
      return db;
    }

    it("prints each metric's value, SLO and pass or fail from a registry file, as JSON and as text", async () => {
      const dir = mkdtempSync(join(tmpdir(), "stats-slo-"));
      try {
        const db = ledgerWithOneMerge(dir);
        writeFileSync(join(dir, "shepherd.yml"), JSON.stringify(REGISTRY));
        const args = ["--db", db, "shepherd", "stats", "--slo", "--registry", join(dir, "shepherd.yml"), "--from", "2026-10-07", "--to", "2026-10-07"];
        const json = capture();
        const text = capture();

        const codes = [await runCli([...args, "--json"], json.io), await runCli(args, text.io)];

        expect(codes).toEqual([0, 0]);
        expect(JSON.parse(json.out.join(""))).toEqual({
          slo: [{ id: "shepherd.business.merges_per_day", family: "business", title: "Merges per day", unit: "count", query: "business.merges-per-day", from: "2026-10-07", to: "2026-10-07", value: 1, n: 1, slo: { objective: "at least 1 a day", op: ">=", target: 1 }, status: "pass" }],
        });
        expect(text.out.join("")).toContain("pass      shepherd.business.merges_per_day  1 count  SLO >= 1 (at least 1 a day)  2026-10-07..2026-10-07  n 1\n");
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it("evaluates this checkout's metrics/shepherd.yml by default", async () => {
      const dir = mkdtempSync(join(tmpdir(), "stats-slo-"));
      try {
        const { out, io } = capture();

        const code = await runCli(["--db", ledgerWithOneMerge(dir), "shepherd", "stats", "--slo", "--json"], io);

        expect(code).toBe(0);
        const results = JSON.parse(out.join("")).slo as { id: string; status: string }[];
        expect(results.map((r) => r.id)).toContain("shepherd.flow.merge_verdict_to_merged");
        expect(results.filter((r) => r.status === "error")).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it("exits 2 naming the field when the registry is invalid", async () => {
      const dir = mkdtempSync(join(tmpdir(), "stats-slo-"));
      try {
        writeFileSync(join(dir, "shepherd.yml"), JSON.stringify({ ...REGISTRY, owner: undefined }));
        const { err, io } = capture();

        const code = await runCli(["--db", ledgerWithOneMerge(dir), "shepherd", "stats", "--slo", "--registry", join(dir, "shepherd.yml")], io);

        expect(code).toBe(2);
        expect(err.join("")).toContain("owner");
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
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
