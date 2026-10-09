import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { openFactoryHost } from "../host.js";
import { factoryRoutes, factoryWorkflows } from "../workflows.js";
import { readCoverage } from "./coverage-read.js";
import { coverage, mergedRows, type CoverageInput, type LedgerRegistration } from "./coverage.js";
import { ShepherdStore } from "./store.js";

const END = Date.parse("2026-10-09T06:00:00Z");
const WINDOW = { start: END - 24 * 3_600_000, end: END };
const AT = "2026-10-08T12:00:00Z";
const iso = (at: number): string => new Date(at).toISOString();

function run(id: string, status: WorkflowRun["status"], merged: boolean, error: string | null = null): WorkflowRun {
  const stepResults: WorkflowRun["stepResults"] = merged
    ? { "merge:0": { stepId: "merge:0", iteration: 0, agentId: null, signal: null, completedAt: AT, data: { result: { done: true } } } }
    : {};
  return { id, workflowName: "shepherd-pr", params: {}, status, currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: iso(WINDOW.start + 3_600_000), completedAt: status === "running" ? null : AT, error };
}

function registration(repo: string, pr: number, runId: string, extra: Partial<LedgerRegistration> = {}): LedgerRegistration {
  return { repo, pr, runId, policy: { merge: "auto" }, held: false, holdReason: null, createdAt: iso(WINDOW.start), ...extra };
}

function row(seat: string, pr: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: AT, agent: `${seat}-impl`, pr, outcome: "merged", note: "merged", ...extra });
}

function input(lines: Record<string, string[]>, registrations: LedgerRegistration[], runs: WorkflowRun[], remotes: Record<string, string[]> = { alpha: ["acme/widgets"] }): CoverageInput {
  const parsed = Object.entries(lines).map(([seat, text]) => mergedRows(seat, text.join("\n")));
  return { rows: parsed.flatMap((p) => p.rows), skipped: parsed.reduce((n, p) => n + p.skipped, 0), registrations, runs, remotes, window: WINDOW };
}

describe("coverage", () => {
  it("counts two merged rows for one PR once, by the first", () => {
    const report = coverage(input({ alpha: [row("alpha", "acme/widgets#7"), row("alpha", "acme/widgets#7", { note: "main green; closed" })] }, [registration("acme/widgets", 7, "r7")], [run("r7", "completed", true)]));

    expect(report.total).toEqual({ merged: 1, excluded: 0, shepherd: 1, share: 1 });
  });

  it("resolves a bare number to the one seat remote with a registration for it", () => {
    const remotes = { alpha: ["acme/widgets", "acme/gadgets"] };
    const report = coverage(input({ alpha: [row("alpha", 775), row("alpha", "776")] }, [registration("acme/gadgets", 775, "r1"), registration("acme/gadgets", 776, "r2"), registration("acme/widgets", 776, "r3")], [run("r1", "completed", true), run("r2", "completed", true), run("r3", "completed", true)], remotes));

    expect(report.total).toMatchObject({ merged: 2, shepherd: 1 });
    expect(report.misses).toEqual([expect.objectContaining({ seat: "alpha", pr: "776", unresolved: true })]);
  });

  it("lists a PR in an unknown form as unresolved, not Shepherd", () => {
    const report = coverage(input({ alpha: [row("alpha", "see notes")] }, [], []));

    expect(report.misses).toEqual([expect.objectContaining({ pr: "see notes", unresolved: true })]);
    expect(report.total.shepherd).toBe(0);
  });

  it("counts a run cancelled because the PR merged outside Shepherd as a miss", () => {
    const outside = run("r7", "cancelled", false, "landed elsewhere: acme/widgets#7 was merged outside Shepherd");
    const report = coverage(input({ alpha: [row("alpha", "acme/widgets#7", { note: "bin/merge" })] }, [registration("acme/widgets", 7, "r7", { holdReason: "no-reviewer: none; TP-1" })], [outside]));

    expect(report.total).toMatchObject({ merged: 1, shepherd: 0, share: 0 });
    expect(report.misses).toEqual([{ seat: "alpha", pr: "acme/widgets#7", note: "bin/merge", holdReason: "no-reviewer: none; TP-1", unresolved: false }]);
  });

  it("does not count a completed run that never merged as Shepherd", () => {
    const report = coverage(input({ alpha: [row("alpha", "acme/widgets#7")] }, [registration("acme/widgets", 7, "r7")], [run("r7", "completed", false)]));

    expect(report.total.shepherd).toBe(0);
  });

  it("keeps a visual or bench row and an owner-gated visual-gate2 hold out of the denominator", () => {
    const gated = registration("acme/widgets", 3, "r3", { policy: { merge: "owner-gate" }, held: true, holdReason: "visual-gate2: owner Ship" });
    const lines = { alpha: [row("alpha", "acme/widgets#1", { gate: "visual" }), row("alpha", "acme/widgets#2", { gate: "bench" }), row("alpha", "acme/widgets#3"), row("alpha", "acme/widgets#4")] };
    const report = coverage(input(lines, [gated], []));

    expect(report.total).toEqual({ merged: 1, excluded: 3, shepherd: 0, share: 0 });
    expect(report.misses.map((m) => m.pr)).toEqual(["acme/widgets#4"]);
  });

  it("reads a row with an offset by its instant, so 23:59 at -06:00 falls in a window ending 06:00Z", () => {
    const lines = { alpha: [row("alpha", "acme/widgets#1", { ts: "2026-10-08T23:59:00-06:00" }), row("alpha", "acme/widgets#2", { ts: "2026-10-09T00:01:00-06:00" })] };

    expect(coverage(input(lines, [], [])).total.merged).toBe(1);
  });

  it("parses fractional seconds and a zoneless time as UTC, and skips and counts bad lines", () => {
    const lines = { alpha: [row("alpha", "acme/widgets#1", { ts: "2026-10-08T07:00:36.657536Z" }), row("alpha", "acme/widgets#2", { ts: "2026-10-09T05:59:00" }), "{not json", row("alpha", "acme/widgets#3", { ts: "yesterday" })] };
    const report = coverage(input(lines, [], []));

    expect(report.total.merged).toBe(2);
    expect(report.skipped).toBe(2);
  });

  it("splits the counts per seat and leaves share undefined for a seat with nothing merged", () => {
    const remotes = { alpha: ["acme/widgets"], beta: ["acme/gadgets"] };
    const report = coverage(input({ alpha: [row("alpha", "acme/widgets#1")], beta: [] }, [registration("acme/widgets", 1, "r1")], [run("r1", "completed", true)], remotes));

    expect(report.seats).toEqual([
      { seat: "alpha", merged: 1, excluded: 0, shepherd: 1, share: 1 },
      { seat: "beta", merged: 0, excluded: 0, shepherd: 0, share: undefined },
    ]);
  });

  it("flags an untyped hold on a run active in the window as a serve path or a seat path", () => {
    const serve = registration("acme/widgets", 1, "r1", { held: true, holdReason: "factory serve down (Morning 98)" });
    const seatPath = registration("acme/widgets", 2, "r2", { held: true, holdReason: "design-coord interim procedure" });
    const typed = registration("acme/widgets", 3, "r3", { held: true, holdReason: "no-reviewer: none; TP-1948" });
    const report = coverage(input({}, [serve, seatPath, typed], [run("r1", "running", false), run("r2", "running", false), run("r3", "running", false)]));

    expect(report.untypedHolds).toEqual([
      { runId: "r1", repo: "acme/widgets", pr: 1, reason: "factory serve down (Morning 98)", servePath: true, seatPath: false },
      { runId: "r2", repo: "acme/widgets", pr: 2, reason: "design-coord interim procedure", servePath: false, seatPath: true },
    ]);
  });

  it("leaves out an untyped hold whose run finished before the window", () => {
    const old = { ...run("r1", "completed", true), completedAt: iso(WINDOW.start - 1) };
    const held = registration("acme/widgets", 1, "r1", { held: true, holdReason: "interim path" });

    expect(coverage(input({}, [held], [old])).untypedHolds).toEqual([]);
  });
});

describe("readCoverage", () => {
  it("folds the seat logs against a ledger it opens read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "coverage-"));
    const dbPath = join(dir, "factory.db");
    openFactoryHost({ dbPath, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const db = openDatabase(dbPath);
    new WorkflowRunStore(db).create(run("r7", "completed", true));
    new ShepherdStore(db).register({ repo: "acme/widgets", pr: 7, runId: "r7", task: "T/X-1", implementer: "impl", policy: { merge: "auto", mergeMethod: "squash", fixer: false, seat: "alpha" } });
    db.close();
    mkdirSync(join(dir, "logs", "alpha"), { recursive: true });
    writeFileSync(join(dir, "logs", "alpha", "dispatch.jsonl"), `${row("alpha", 7)}\n${row("alpha", "acme/widgets#8")}\n`);

    const report = readCoverage({ dbPath, logsDir: join(dir, "logs"), remotes: { alpha: ["acme/widgets"], beta: ["acme/gadgets"] }, window: WINDOW });

    expect(report.total).toEqual({ merged: 2, excluded: 0, shepherd: 1, share: 0.5 });
    expect(report.misses.map((m) => m.pr)).toEqual(["acme/widgets#8"]);
  });
});
