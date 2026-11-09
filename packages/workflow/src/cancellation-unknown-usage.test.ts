import { afterEach, describe, expect, it } from "vitest";
import {
  codexExecCapabilities,
  createDurableHarnessDispatcher,
  type DurableHarnessSuccess,
  type HarnessAdapter,
  type HarnessRunResult,
} from "@titan-design/agent";
import { SqliteExecutionLedger, executionLedgerMigration } from "@titan-design/agent-lifecycle";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { durableHarnessRunner } from "./durable-harness-runner.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration } from "./store.js";
import type { DurableStepOutcome, RecoverableStepRunner, StepReconcileOutcome, StepRunner, WorkflowFn } from "./types.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const conversation = { harness: "codex", namespace: "test", nativeId: "conversation" };
const execution = { executionId: "native-invocation", conversation };
const workflow: WorkflowFn = async ctx => { await ctx.dispatch("work", "work"); };
const unsettledSpend = { costUsd: 0.07, inputTokens: 900, outputTokens: 60 };
const unsettled: DurableStepOutcome = { kind: "cancellation_unknown", reason: "aborted: signalled", usage: unsettledSpend };

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

/** A real ledger and dispatcher whose harness stops without native terminal evidence after spending. */
function ledgerRunner(db: Db, supervisorId: string): StepRunner {
  const ledger = new SqliteExecutionLedger<DurableHarnessSuccess<unknown, "codex">>(db);
  const stopped: HarnessRunResult<never, "codex"> = {
    ok: false, harness: "codex", execution, conversation,
    failure: { kind: "cancelled_unknown", reason: "process stopped" },
    usage: [{ kind: "delta", responseId: "r1", model: "test", source: "test", cost: { usd: 0.07, kind: "estimate" },
      tokens: { input: 900, output: 60, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: null } }],
  };
  const adapter: HarnessAdapter<"codex"> = {
    descriptor: codexExecCapabilities(),
    run: async request => {
      request.onProgress?.({ kind: "execution_started", harness: "codex", atMs: Date.now(), execution });
      return stopped;
    },
  };
  const dispatcher = createDurableHarnessDispatcher(adapter, { ledger, supervisorId, leaseMs: 60_000 });
  return durableHarnessRunner(dispatcher, { request: input => ({
    harness: "codex", prompt: input.prompt, cwd: "/tmp", target: { kind: "fresh", namespace: "test" },
    wallTimeMs: 30_000, native: { model: "test" },
  }) });
}

/** Answers each dispatch and each reconcile from a script, in order, as successive hosts would see them. */
function scriptedRunner(dispatches: DurableStepOutcome[], reconciles: StepReconcileOutcome[]): RecoverableStepRunner {
  return {
    dispatch: async input => ({
      executionId: input.executionId, requestKey: input.requestKey, runnerRef: `ref-${input.attempt}`,
      completion: Promise.resolve(dispatches.shift()!),
    }),
    reconcile: async () => reconciles.shift()!,
  };
}

async function resumed(db: Db, runner: StepRunner, runId: string) {
  const runtime = drive(db, runner);
  await runtime.hydrate();
  return { runtime, run: await runtime.wait(runId) };
}

describe("a durable step whose cancellation is unknown after spending", () => {
  it("charges the spend once to the answer an operator records after reconcile returns the same terminal", async () => {
    const db = makeDb();
    const first = drive(db, ledgerRunner(db, "first"));
    const runId = first.start("work");
    expect((await first.wait(runId)).status).toBe("recovery_required");
    const { runtime: second, run: parkedAgain } = await resumed(db, ledgerRunner(db, "second"), runId);
    expect(parkedAgain.status).toBe("recovery_required");

    const answered = second.completeStep(runId, "work", "done by hand");

    expect(answered).toBe(true);
    expect(second.status(runId)?.stepResults["work:0"]?.usage).toEqual(unsettledSpend);
  });

  it("charges the spend once alongside the retry that replaces the parked try", async () => {
    const db = makeDb();
    const runner = scriptedRunner(
      [unsettled, { kind: "succeeded", output: "done", usage: { costUsd: 0.05, inputTokens: 400, outputTokens: 30 } }],
      [{ kind: "terminal", outcome: unsettled, evidence: "ledger" }, { kind: "not_found", retrySafe: true, evidence: "ledger pruned" }],
    );
    const first = drive(db, runner);
    const runId = first.start("work");
    expect((await first.wait(runId)).status).toBe("recovery_required");
    expect((await resumed(db, runner, runId)).run.status).toBe("recovery_required");

    const { run } = await resumed(db, runner, runId);

    expect(run.status).toBe("completed");
    expect(run.stepResults["work:0"]?.usage?.costUsd).toBeCloseTo(0.12);
    expect(run.stepResults["work:0"]?.usage).toMatchObject({ inputTokens: 1300, outputTokens: 90 });
  });
});
