import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { describe, expect, it, vi } from "vitest";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { RecoverableStepRunner, WorkflowFn } from "./types.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

function runtime(db: Db, runner: RecoverableStepRunner): WorkflowRuntime {
  const gates = new SqliteGateStore(db, { migrate: false });
  return new WorkflowRuntime({ db, gates, runner, gatePollMs: 10, executionId: () => "execution-1" });
}

const oneDispatch: WorkflowFn = async (ctx) => {
  await ctx.dispatch("work", "work");
};

const neverSettles = (): Promise<never> => new Promise<never>(() => undefined);

describe("a runner acknowledgment that does not match the persisted intent", () => {
  it("parks the run for recovery when the ack names a foreign executionId", async () => {
    const db = makeDb();
    const rt = runtime(db, {
      dispatch: async (input) => ({ executionId: "execution-foreign", requestKey: input.requestKey, runnerRef: "runner-1", completion: neverSettles() }),
      reconcile: async () => ({ kind: "unknown", evidence: "not used" }),
    });
    rt.register("durable", oneDispatch);
    const runId = rt.start("durable");

    await vi.waitFor(() => expect(rt.status(runId)?.status).toBe("recovery_required"));
    expect(rt.status(runId)).toMatchObject({
      error: expect.stringContaining("does not match the persisted execution intent"),
      activeSteps: { work: { recovery: { kind: "unknown" } } },
    });
    expect(rt.status(runId)?.activeSteps.work?.runnerRef).toBeUndefined();
    rt.shutdown();
  });
});

describe("a reconcile that reports a running step with a blank runnerRef", () => {
  it("leaves the run in recovery_required instead of adopting the blank reference", async () => {
    const db = makeDb();
    const first = runtime(db, {
      dispatch: async (input) => ({ executionId: input.executionId, requestKey: input.requestKey, runnerRef: "runner-1", completion: neverSettles() }),
      reconcile: async () => ({ kind: "unknown", evidence: "not used before restart" }),
    });
    first.register("durable", oneDispatch);
    const runId = first.start("durable");
    await vi.waitFor(() => expect(first.status(runId)?.activeSteps.work?.runnerRef).toBe("runner-1"));
    first.shutdown();

    const second = runtime(db, {
      dispatch: async () => { throw new Error("must not redispatch"); },
      reconcile: async () => ({ kind: "running", runnerRef: " ", completion: neverSettles(), evidence: "still running" }),
    });
    second.register("durable", oneDispatch);
    expect(await second.hydrate()).toEqual([]);

    expect(second.status(runId)).toMatchObject({
      status: "recovery_required",
      activeSteps: { work: { runnerRef: "runner-1", recovery: { kind: "unknown", evidence: "reconcile returned an empty runner reference" } } },
    });
    second.shutdown();
  });
});
