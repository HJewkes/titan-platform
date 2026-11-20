import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import { WorkflowRunStore, workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { DurableStepOutcome, RecoverableStepRunner, WorkflowFn } from "./types.js";

const oneDispatch: WorkflowFn = async (ctx) => void (await ctx.dispatch("work", "work"));
const gated: WorkflowFn = async (ctx) => void (await ctx.assisted("approve", "ok?"));

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

function runtime(db: Db, runner: ConstructorParameters<typeof WorkflowRuntime>[0]["runner"] = inlineRunner(() => "ok")): WorkflowRuntime {
  const gates = new SqliteGateStore(db, { migrate: false });
  const rt = new WorkflowRuntime({ db, gates, runner, gatePollMs: 10, executionId: () => "original-execution" });
  rt.register("gated", gated);
  rt.register("durable", oneDispatch);
  return rt;
}

function row(db: Db, runId: string) {
  return new WorkflowRunStore(db).get(runId);
}

function pending(): RecoverableStepRunner {
  return {
    dispatch: async (input) => ({
      executionId: input.executionId,
      requestKey: input.requestKey,
      runnerRef: input.executionId,
      completion: new Promise<DurableStepOutcome>(() => undefined),
    }),
    reconcile: async () => ({ kind: "unknown", evidence: "not used" }),
  };
}

describe("WorkflowRuntime.shutdown", () => {
  it("hydrates nothing after shutdown and reports not quiesced", async () => {
    const db = makeDb();
    const first = runtime(db);
    const runId = first.start("gated");
    await vi.waitFor(() => expect(first.status(runId)?.status).toBe("paused"));
    first.shutdown();
    const stopped = runtime(db);
    stopped.shutdown();

    expect(await stopped.hydrate()).toEqual([]);
    expect(row(db, runId)?.owner).toBeUndefined();
    expect(stopped.quiesced()).toBe(false);
  });

  it("leaves a run started after shutdown unclaimed for a successor", async () => {
    const db = makeDb();
    const stopped = runtime(db);
    stopped.shutdown();

    const runId = stopped.start("gated");

    expect(row(db, runId)?.status).toBe("running");
    expect(row(db, runId)?.owner).toBeUndefined();
    const successor = runtime(db);
    expect(await successor.hydrate()).toEqual([runId]);
    successor.shutdown();
  });

  it("releases a run whose reconcile is still pending when shutdown lands, and never launches it", async () => {
    const db = makeDb();
    const first = runtime(db, pending());
    const runId = first.start("durable");
    await vi.waitFor(() => expect(first.status(runId)?.activeSteps.work?.runnerRef).toBe("original-execution"));
    first.shutdown();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const dispatch = vi.fn();
    const second = runtime(db, {
      dispatch,
      reconcile: async () => {
        await gate;
        return { kind: "terminal", outcome: { kind: "succeeded", output: "done" }, evidence: "ledger" };
      },
    });
    const hydrating = second.hydrate();
    await vi.waitFor(() => expect(row(db, runId)?.owner).toBeDefined());

    second.shutdown();
    finish();

    expect(await hydrating).toEqual([]);
    expect(row(db, runId)?.owner).toBeUndefined();
    expect(row(db, runId)?.status).toBe("running");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
