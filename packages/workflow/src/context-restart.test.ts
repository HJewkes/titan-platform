import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { routedRunner, type RouteRunner, type RoutedStepInput } from "./routed-runner.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { StepRunOutcome, WorkflowFn } from "./types.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

const oneStep: WorkflowFn = async (ctx) => {
  await ctx.dispatch("work", "do the work");
};

/** A runtime whose `work` step repeats on restart and answers each try with the next scripted outcome. */
function runtime(db: Db, inputs: RoutedStepInput[], outcomes: (StepRunOutcome | "hang")[] = ["hang"]): WorkflowRuntime {
  const runner: RouteRunner = {
    run: (input) => {
      inputs.push(input);
      const next = outcomes.shift() ?? "hang";
      return next === "hang" ? new Promise(() => undefined) : Promise.resolve(next);
    },
  };
  const rt = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner: routedRunner([{ match: "work", onRestart: "repeat", runner }]), gatePollMs: 10 });
  rt.register("one", oneStep);
  return rt;
}

/** Starts a run whose step hangs, then restarts it `times` times, each time on a fresh runtime over the same db. */
async function restartedRun(db: Db, times: number, inputs: RoutedStepInput[]): Promise<string> {
  const first = runtime(db, inputs);
  const runId = first.start("one");
  await vi.waitFor(() => expect(inputs).toHaveLength(1));
  first.shutdown();
  for (let restart = 1; restart <= times; restart += 1) {
    const next = runtime(db, inputs);
    expect(await next.hydrate()).toEqual([runId]);
    await vi.waitFor(() => expect(inputs).toHaveLength(restart + 1));
    next.shutdown();
  }
  return runId;
}

describe("a step a restart re-dispatches", () => {
  it("keeps its first start and counts the restart", async () => {
    const db = makeDb();
    const inputs: RoutedStepInput[] = [];
    const runId = await restartedRun(db, 1, inputs);

    const [first, repeat] = inputs;
    expect(first).toMatchObject({ attempt: 0, restarts: 0 });
    expect(repeat).toMatchObject({ attempt: 1, restarts: 1, firstStartedAt: first!.firstStartedAt });
    const active = runtime(db, []).status(runId)?.activeSteps.work;
    expect(active).toMatchObject({ attempt: 1, restarts: 1, firstStartedAt: first!.firstStartedAt });
  });

  it("still gets its retry after two restarts, so one retryable failure does not fail the run", async () => {
    const db = makeDb();
    const inputs: RoutedStepInput[] = [];
    const runId = await restartedRun(db, 2, inputs);
    const last = runtime(db, inputs, [{ ok: false, error: "transient", retryable: true }, { ok: true, output: "done" }]);

    await last.hydrate();
    const run = await last.wait(runId);

    expect(run).toMatchObject({ status: "completed", stepResults: { "work:0": { output: "done", attempt: 4 } } });
    expect(inputs.slice(3).map(({ attempt, restarts }) => ({ attempt, restarts }))).toEqual([{ attempt: 3, restarts: 3 }, { attempt: 4, restarts: 3 }]);
    expect(new Set(inputs.map((input) => input.firstStartedAt)).size).toBe(1);
  });

  it("reads a row stored without the new fields as first started at its startedAt, never restarted", async () => {
    const db = makeDb();
    const inputs: RoutedStepInput[] = [];
    const first = runtime(db, inputs);
    const runId = first.start("one");
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    first.shutdown();
    withoutRestartFields(db, runId, "2026-01-01T00:00:00.000Z");

    const second = runtime(db, inputs);
    expect(await second.hydrate()).toEqual([runId]);
    await vi.waitFor(() => expect(inputs).toHaveLength(2));

    expect(inputs[1]).toMatchObject({ attempt: 1, restarts: 1, firstStartedAt: "2026-01-01T00:00:00.000Z" });
    second.shutdown();
  });
});

/** Rewrites the run's active step as a release before restart counting stored it, started at `startedAt`. */
function withoutRestartFields(db: Db, runId: string, startedAt: string): void {
  const row = db.prepare("SELECT active_steps FROM workflow_run WHERE id = ?").get(runId) as { active_steps: string };
  const work = { ...JSON.parse(row.active_steps).work, startedAt };
  delete work.firstStartedAt;
  delete work.restarts;
  db.prepare("UPDATE workflow_run SET active_steps = ? WHERE id = ?").run(JSON.stringify({ work }), runId);
}
