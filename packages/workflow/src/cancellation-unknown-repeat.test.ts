import { afterEach, describe, expect, it } from "vitest";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { executionLedgerMigration } from "@titan-design/agent-lifecycle";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration } from "./store.js";
import type { DurableStepOutcome, RecoverableStepRunner, StepReconcileOutcome, StepRunner, WorkflowFn } from "./types.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const workflow: WorkflowFn = async ctx => { await ctx.dispatch("work", "work"); };
const firstSpend = { costUsd: 0.07, inputTokens: 900, outputTokens: 60 };
const withSpend: DurableStepOutcome = { kind: "cancellation_unknown", reason: "aborted: signalled", usage: firstSpend };
const withoutSpend: DurableStepOutcome = { kind: "cancellation_unknown", reason: "aborted: signalled again" };

function makeDb(): Db {
  const db = openDatabase(":memory:");
  cleanups.push(() => db.close());
  runMigrations(db, [gateMigration(1), workflowMigration(2), executionLedgerMigration(3), gateResolverMigration(4)]);
  return db;
}

function drive(db: Db, runner: StepRunner): WorkflowRuntime {
  const runtime = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner });
  runtime.register("work", workflow);
  cleanups.push(() => runtime.shutdown());
  return runtime;
}

function scriptedRunner(dispatches: DurableStepOutcome[], reconciles: StepReconcileOutcome[]): RecoverableStepRunner {
  return {
    dispatch: async input => ({
      executionId: input.executionId, requestKey: input.requestKey, runnerRef: `ref-${input.attempt}`,
      completion: Promise.resolve(dispatches.shift()!),
    }),
    reconcile: async () => reconciles.shift()!,
  };
}

describe("a parked step whose repeat cancellation_unknown report carries no usage", () => {
  it("keeps the first report's spend charged once on the operator's answer", async () => {
    const db = makeDb();
    const runner = scriptedRunner([withSpend], [{ kind: "terminal", outcome: withoutSpend, evidence: "ledger" }]);
    const first = drive(db, runner);
    const runId = first.start("work");
    expect((await first.wait(runId)).status).toBe("recovery_required");
    const second = drive(db, runner);
    await second.hydrate();
    expect((await second.wait(runId)).status).toBe("recovery_required");

    const answered = second.completeStep(runId, "work", "done by hand");

    expect(answered).toBe(true);
    expect(second.status(runId)?.stepResults["work:0"]?.usage).toEqual(firstSpend);
  });
});
