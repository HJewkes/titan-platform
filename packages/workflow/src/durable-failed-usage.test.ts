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
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { durableHarnessRunner } from "./durable-harness-runner.js";
import { mapItems, type MapResult } from "./fan-out.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration } from "./store.js";
import { StepFailedError, type WorkflowFn } from "./types.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

type Measurement = DurableHarnessSuccess["usage"][number];
type Result = HarnessRunResult<string, "codex">;
const conversation = { harness: "codex", namespace: "test", nativeId: "conversation" };
const execution = { executionId: "native-invocation", conversation };

function spent(responseId: string, usd: number, input: number, output: number): Measurement {
  return {
    kind: "delta", responseId, model: "test", source: "test", cost: { usd, kind: "estimate" },
    tokens: { input, output, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: null },
  };
}

function failure(usage: Measurement[]): Result {
  return { ok: false, harness: "codex", execution, conversation, failure: { kind: "output_invalid", reason: "schema mismatch" }, usage };
}

function success(usage: Measurement[]): Result {
  return { ok: true, harness: "codex", execution, conversation, output: { kind: "text", text: "done" }, usage };
}

/** A workflow over a real ledger and dispatcher whose fake harness answers each prompt with a fixed result. */
function durableRuntime(results: Record<string, Result>, workflow: WorkflowFn) {
  const db = openDatabase(":memory:");
  cleanups.push(() => db.close());
  runMigrations(db, [gateMigration(1), workflowMigration(2), executionLedgerMigration(3), gateResolverMigration(4)]);
  const ledger = new SqliteExecutionLedger<DurableHarnessSuccess<unknown, "codex">>(db);
  const run: HarnessAdapter<"codex">["run"] = async request => {
    request.onProgress?.({ kind: "execution_started", harness: "codex", atMs: Date.now(), execution });
    return results[request.prompt] as HarnessRunResult<never, "codex">;
  };
  const adapter: HarnessAdapter<"codex"> = { descriptor: codexExecCapabilities(), run };
  const dispatcher = createDurableHarnessDispatcher(adapter, { ledger, supervisorId: "supervisor", leaseMs: 60_000 });
  const runner = durableHarnessRunner(dispatcher, { request: input => ({
    harness: "codex", prompt: input.prompt, cwd: "/tmp", target: { kind: "fresh", namespace: "test" },
    wallTimeMs: 30_000, native: { model: "test" },
  }) });
  const runtime = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner });
  runtime.register("work", workflow);
  cleanups.push(() => runtime.shutdown());
  return runtime;
}

async function stepFailure(result: Result): Promise<unknown> {
  let caught: unknown;
  const runtime = durableRuntime({ work: result }, async ctx => {
    try { await ctx.dispatch("work", "work"); }
    catch (error) { caught = error; throw error; }
  });
  await runtime.wait(runtime.start("work"));
  return caught;
}

describe("a durable step that fails after spending", () => {
  it("reports the spend on StepFailedError.usage", async () => {
    const error = await stepFailure(failure([spent("r1", 0.07, 900, 60)]));

    expect(error).toBeInstanceOf(StepFailedError);
    expect((error as StepFailedError).usage).toEqual({ costUsd: 0.07, inputTokens: 900, outputTokens: 60 });
  });

  it("leaves StepFailedError.usage undefined when the harness reported no spend", async () => {
    const error = await stepFailure(failure([]));

    expect(error).toBeInstanceOf(StepFailedError);
    expect((error as StepFailedError).usage).toBeUndefined();
  });

  it("is counted once in the mapItems budget alongside a succeeding item", async () => {
    const results = { "judge a": failure([spent("r1", 0.07, 900, 60)]), "judge b": success([spent("r2", 0.05, 400, 30)]) };
    const sink: MapResult<string>[] = [];
    const runtime = durableRuntime(results, async ctx => {
      sink.push(await mapItems(ctx, "judge", ["a", "b"], (item, stepId) => ctx.dispatch(stepId, `judge ${item}`),
        { key: item => item, concurrency: 2 }));
    });

    await runtime.wait(runtime.start("work"));

    expect(sink[0]?.spentUsd).toBeCloseTo(0.12);
    expect(sink[0]?.failed[0]?.usage?.costUsd).toBe(0.07);
    expect(sink[0]?.results[0]?.result.usage?.costUsd).toBe(0.05);
  });
});
