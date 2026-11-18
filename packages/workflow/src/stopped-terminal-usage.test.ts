import { afterEach, describe, expect, it } from "vitest";
import {
  codexExecCapabilities,
  createDurableHarnessDispatcher,
  type DurableHarnessSuccess,
  type HarnessAdapter,
  type HarnessRunFailure,
  type HarnessRunResult,
} from "@titan-design/agent";
import { SqliteExecutionLedger, executionLedgerMigration } from "@titan-design/agent-lifecycle";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { durableHarnessRunner } from "./durable-harness-runner.js";
import { mapItems, type MapResult } from "./fan-out.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration } from "./store.js";
import type { RecoverableStepRunner, StepRunner, WorkflowFn } from "./types.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const conversation = { harness: "codex", namespace: "test", nativeId: "conversation" };
const execution = { executionId: "native-invocation", conversation };

function makeDb(): Db {
  const db = openDatabase(":memory:");
  cleanups.push(() => db.close());
  runMigrations(db, [gateMigration(1), workflowMigration(2), executionLedgerMigration(3), gateResolverMigration(4)]);
  return db;
}

const measured = (usd: number, input: number, output: number) => [{
  kind: "delta" as const, responseId: `r-${usd}`, model: "test", source: "test", cost: { usd, kind: "estimate" as const },
  tokens: { input, output, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: null },
}];

/** A real ledger and dispatcher whose harness answers every run with `result`. */
function ledgerRunner(db: Db, supervisorId: string, result: HarnessRunResult<never, "codex">): RecoverableStepRunner {
  const ledger = new SqliteExecutionLedger<DurableHarnessSuccess<unknown, "codex">>(db);
  const adapter: HarnessAdapter<"codex"> = {
    descriptor: codexExecCapabilities(),
    run: async request => {
      request.onProgress?.({ kind: "execution_started", harness: "codex", atMs: Date.now(), execution });
      return result;
    },
  };
  const dispatcher = createDurableHarnessDispatcher(adapter, { ledger, supervisorId, leaseMs: 60_000 });
  return durableHarnessRunner(dispatcher, { request: input => ({
    harness: "codex", prompt: input.prompt, cwd: "/tmp", target: { kind: "fresh", namespace: "test" },
    wallTimeMs: 30_000, native: { model: "test" },
  }) });
}

function stoppingRunner(db: Db, supervisorId: string, failure: HarnessRunFailure): RecoverableStepRunner {
  return ledgerRunner(db, supervisorId, { ok: false, harness: "codex", execution, conversation, failure, usage: measured(0.07, 900, 60) });
}

/** A host whose ledger lost the stopped record, so the step is safe to repeat, and whose harness then succeeds. */
function retryingRunner(db: Db): RecoverableStepRunner {
  const succeeding = ledgerRunner(db, "retry", {
    ok: true, harness: "codex", execution, conversation, output: { kind: "text", text: "done" }, usage: measured(0.05, 400, 30),
  });
  return { ...succeeding, reconcile: async () => ({ kind: "not_found", retrySafe: true, evidence: "ledger pruned" }) };
}

/** One budgeted fan-out item; `spent` keeps what the fan-out counted against its budget. */
function host(db: Db, runner: StepRunner, spent: MapResult<string>[]): WorkflowRuntime {
  const workflow: WorkflowFn = async ctx => {
    spent.push(await mapItems(ctx, "items", ["only"], (item, stepId, c) => c.dispatch(stepId, item), { key: item => item, budgetUsd: 1 }));
  };
  const runtime = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner });
  runtime.register("work", workflow);
  cleanups.push(() => runtime.shutdown());
  return runtime;
}

const stops: [string, HarnessRunFailure][] = [
  ["aborted", { kind: "aborted", reason: "signalled" }],
  ["wall_time_exceeded", { kind: "wall_time_exceeded", reason: "deadline", wallTimeMs: 30_000 }],
  ["cancelled_unknown", { kind: "cancelled_unknown", reason: "process stopped" }],
];

describe("a durable fan-out item whose harness stops after spending", () => {
  it.each(stops)("counts the spend of a %s stop once against the budget, though reconcile returns the terminal again", async (_, failure) => {
    const db = makeDb();
    const spent: MapResult<string>[] = [];
    const first = host(db, stoppingRunner(db, "first", failure), spent);
    const runId = first.start("work");
    expect((await first.wait(runId)).status).toBe("recovery_required");
    first.shutdown();
    const second = host(db, stoppingRunner(db, "second", failure), spent);
    await second.hydrate();
    expect((await second.wait(runId)).status).toBe("recovery_required");
    second.shutdown();
    const third = host(db, retryingRunner(db), spent);

    await third.hydrate();
    const run = await third.wait(runId);

    expect(run.status).toBe("completed");
    expect(run.stepResults["items/only:0"]?.usage).toMatchObject({ inputTokens: 1300, outputTokens: 90 });
    expect(spent).toHaveLength(1);
    expect(spent[0]?.spentUsd).toBeCloseTo(0.12);
  });
});
