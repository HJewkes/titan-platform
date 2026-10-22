import { createHash } from "node:crypto";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { codeRecordRoute } from "./code-step.js";
import { mapItems } from "./fan-out.js";
import { routedRunner, type RouteRunner, type StepRoute } from "./routed-runner.js";
import { WorkflowRuntime } from "./runtime.js";
import { WorkflowRunStore, workflowMigration, workflowOwnershipMigration } from "./store.js";
import { projectRunTrace } from "./trace-projection.js";
import type { StepResult, StepRunOutcome, WorkflowEvent, WorkflowFn, WorkflowRun } from "./types.js";

const EARLIER = "2026-01-01T00:00:00.000Z";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

const oneStep: WorkflowFn = async (ctx) => {
  await ctx.dispatch("work", "do the work");
};

function scripted(outcomes: (StepRunOutcome | "hang")[], calls: string[]): RouteRunner {
  return {
    run: (input) => {
      calls.push(input.stepId);
      const next = outcomes.shift() ?? "hang";
      return next === "hang" ? new Promise(() => undefined) : Promise.resolve(next);
    },
  };
}

function runtime(db: Db, routes: StepRoute[], extra: { onEvent?: (event: WorkflowEvent) => void; now?: () => number } = {}): WorkflowRuntime {
  const rt = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner: routedRunner(routes), gatePollMs: 10, ...extra });
  rt.register("one", oneStep);
  return rt;
}

function workRoute(outcomes: (StepRunOutcome | "hang")[], calls: string[]): StepRoute {
  return { match: "work", onRestart: "repeat", runner: scripted(outcomes, calls) };
}

/** Rewrites one column of a stored run through `edit`, as an older release or a restart long ago would have left it. */
function rewriteColumn(db: Db, runId: string, column: "active_steps" | "step_results", edit: (value: Record<string, Record<string, unknown>>) => void): void {
  const stored: unknown = db.prepare(`SELECT ${column} FROM workflow_run WHERE id = ?`).pluck().get(runId);
  if (typeof stored !== "string") throw new Error(`run ${runId} has no ${column}`);
  const value = JSON.parse(stored) as Record<string, Record<string, unknown>>;
  edit(value);
  db.prepare(`UPDATE workflow_run SET ${column} = ? WHERE id = ?`).run(JSON.stringify(value), runId);
}

describe("step timing on a completed result", () => {
  it("records a single try's start as both its start and its first start, with no restarts", async () => {
    const rt = runtime(makeDb(), [workRoute([{ ok: true, output: "done" }], [])]);

    const run = await rt.wait(rt.start("one"));

    const result = run.stepResults["work:0"]!;
    expect(result).toMatchObject({ restarts: 0, firstStartedAt: result.startedAt });
    expect(result.startedAt! <= result.completedAt).toBe(true);
  });

  it("keeps the first start and the restart count after a restart re-dispatches the step", async () => {
    const db = makeDb();
    const calls: string[] = [];
    const first = runtime(db, [workRoute(["hang"], calls)]);
    const runId = first.start("one");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    first.shutdown();
    rewriteColumn(db, runId, "active_steps", (steps) => Object.assign(steps.work!, { startedAt: EARLIER, firstStartedAt: EARLIER }));

    const second = runtime(db, [workRoute([{ ok: true, output: "done" }], calls)]);
    await second.hydrate();
    const run = await second.wait(runId);

    const result = run.stepResults["work:0"]!;
    expect(result).toMatchObject({ output: "done", attempt: 1, restarts: 1, firstStartedAt: EARLIER });
    expect(result.startedAt! > EARLIER).toBe(true);
  });

  it("loads a result stored before the timing fields as before, and traces it at its completion", async () => {
    const db = makeDb();
    const rt = runtime(db, [workRoute([{ ok: true, output: "done" }], [])]);
    const runId = rt.start("one");
    await rt.wait(runId);
    rewriteColumn(db, runId, "step_results", (results) => {
      for (const field of ["startedAt", "firstStartedAt", "restarts"]) delete results["work:0"]![field];
    });

    const run = new WorkflowRunStore(db).get(runId)!;

    const result = run.stepResults["work:0"]!;
    expect(result).toMatchObject({ output: "done", attempt: 0 });
    expect(Object.keys(result)).not.toContain("startedAt");
    expect(traceStarts(run)).toEqual([result.completedAt]);
  });

  it("traces an attempt at the start its result recorded", () => {
    const result: StepResult = { stepId: "work", iteration: 0, operation: "dispatch", agentId: "ref-1", signal: null, startedAt: EARLIER, completedAt: "2026-01-01T00:05:00.000Z", output: "done" };

    expect(traceStarts(storedRun({ "work:0": result }))).toEqual([EARLIER]);
  });
});

describe("workflow events", () => {
  it("carry the runtime clock's time as `at`", async () => {
    const events: WorkflowEvent[] = [];
    const now = Date.parse("2026-03-04T05:06:07.000Z");
    const rt = runtime(makeDb(), [workRoute([{ ok: true, output: "done" }], [])], { onEvent: (event) => events.push(event), now: () => now });

    await rt.wait(rt.start("one"));

    expect(events.map((event) => event.type)).toEqual(["step_started", "step_complete", "workflow_complete"]);
    expect(events.map((event) => event.at)).toEqual(Array(3).fill("2026-03-04T05:06:07.000Z"));
  });
});

describe("a code record route that reports usage", () => {
  const judge = (key: string, costUsd: number) =>
    codeRecordRoute(`judge/${key}`, async () => ({ result: { verdict: "pass" }, usage: { costUsd, inputTokens: 10, model: "test-model" } }));

  it("records the usage as the step's and keeps it off the stored record", async () => {
    const db = makeDb();
    const rt = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner: routedRunner([judge("a", 0.25)]), gatePollMs: 10 });
    rt.register("judge", async (ctx) => void (await ctx.dispatch("judge/a", "{}")));

    const run = await rt.wait(rt.start("judge"));

    const result = run.stepResults["judge/a:0"]!;
    expect(result.usage).toEqual({ costUsd: 0.25, inputTokens: 10, model: "test-model" });
    expect(JSON.parse(result.output!)).toEqual({ result: { verdict: "pass" } });
  });

  it("is summed against a fan-out's budget like a dispatch's usage", async () => {
    const db = makeDb();
    const rt = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner: routedRunner([judge("a", 0.25), judge("b", 0.5), judge("c", 1)]), gatePollMs: 10 });
    let spent: { spentUsd: number; stoppedBy: string | null; skipped: string[] } | undefined;
    rt.register("judge", async (ctx) => {
      const map = await mapItems(ctx, "judge", ["a", "b", "c"], (_item, stepId) => ctx.dispatch(stepId, "{}"), { key: (item) => item, budgetUsd: 0.7 });
      spent = { spentUsd: map.spentUsd, stoppedBy: map.stoppedBy, skipped: map.skipped.map((entry) => entry.key) };
    });

    await rt.wait(rt.start("judge"));

    expect(spent).toEqual({ spentUsd: 0.75, stoppedBy: "budget", skipped: ["c"] });
  });
});

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function traceStarts(run: WorkflowRun): string[] {
  return projectRunTrace(run, { gates: { get: () => undefined }, digest }).flatMap((record) => (record.kind === "attempt" ? [record.at] : []));
}

function storedRun(stepResults: Record<string, StepResult>): WorkflowRun {
  return {
    id: "run-1", workflowName: "one", params: {}, status: "completed", currentStep: null, stepResults, activeSteps: {},
    revision: 1, ownerGeneration: 1, startedAt: EARLIER, completedAt: "2026-01-01T00:06:00.000Z", error: null,
  };
}
