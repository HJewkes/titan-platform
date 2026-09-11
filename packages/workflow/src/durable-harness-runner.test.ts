import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexExecCapabilities,
  createDurableHarnessDispatcher,
  type DurableHarnessSuccess,
  type HarnessAdapter,
  type HarnessRunResult,
} from "@titan-design/agent";
import { SqliteExecutionLedger, executionLedgerMigration } from "@titan-design/agent-lifecycle";
import { SqliteGateStore, gateMigration } from "@titan-design/hitl";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { durableHarnessRunner } from "./durable-harness-runner.js";
import { WorkflowRuntime } from "./runtime.js";
import { WorkflowRunStore, workflowMigration } from "./store.js";
import type { WorkflowFn } from "./types.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const conversation = { harness: "codex", namespace: "test", nativeId: "conversation" };
const successful: HarnessRunResult<string, "codex"> = {
  ok: true, harness: "codex", execution: { executionId: "native-invocation", conversation },
  conversation, output: { kind: "text", text: "durable answer" }, usage: [],
};
const workflow: WorkflowFn = async ctx => { await ctx.dispatch("work", "Do the work"); };

function setup() {
  const db = openDatabase(":memory:");
  cleanups.push(() => db.close());
  runMigrations(db, [gateMigration(1), workflowMigration(2), executionLedgerMigration(3)]);
  let now = Date.now();
  const ledger = new SqliteExecutionLedger<DurableHarnessSuccess<unknown, "codex">>(db, { now: () => new Date(now).toISOString() });
  let finish!: (result: HarnessRunResult<string, "codex">) => void;
  const native = new Promise<HarnessRunResult<string, "codex">>(resolve => { finish = resolve; });
  const run = vi.fn<HarnessAdapter<"codex">["run"]>(async request => {
    request.onProgress?.({ kind: "execution_started", harness: "codex", atMs: now, execution: successful.execution! });
    return native as Promise<HarnessRunResult<never, "codex">>;
  });
  const adapter: HarnessAdapter<"codex"> = { descriptor: codexExecCapabilities(), run: run as HarnessAdapter<"codex">["run"] };
  function dispatcher(supervisorId: string) {
    return createDurableHarnessDispatcher(adapter, { ledger, supervisorId, leaseMs: 60_000 }, { now: () => now });
  }
  function runtime(supervisorId: string) {
    const harness = dispatcher(supervisorId);
    const runner = durableHarnessRunner(harness, { request: input => ({
      harness: "codex", prompt: input.prompt, cwd: "/tmp", target: { kind: "fresh", namespace: "test" },
      wallTimeMs: 30_000, native: { model: "test" },
    }) });
    const runtime = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner });
    runtime.register("work", workflow);
    cleanups.push(() => runtime.shutdown());
    return { runtime, harness, runner };
  }
  return { db, ledger, run, finish, runtime, advance: (ms: number) => { now += ms; } };
}

async function acknowledged(runtime: WorkflowRuntime, runId: string) {
  await vi.waitFor(() => expect(runtime.status(runId)?.activeSteps.work?.runnerRef).toBeTruthy());
  const step = runtime.status(runId)!.activeSteps.work!;
  if (step.kind !== "recoverable") throw new Error("Expected recoverable intent");
  return step;
}

describe("durable harness workflow integration", () => {
  it("persists the acknowledgment before completion and recovers a terminal receipt after workflow shutdown", async () => {
    const fixture = setup();
    const first = fixture.runtime("first");
    const runId = first.runtime.start("work");
    const active = await acknowledged(first.runtime, runId);
    expect(new WorkflowRunStore(fixture.db).get(runId)?.activeSteps.work).toMatchObject({ executionId: active.executionId, runnerRef: active.executionId });
    expect(fixture.ledger.get(active.executionId)?.phase).toBe("running");
    expect(fixture.run).toHaveBeenCalledTimes(1);
    first.runtime.shutdown();
    fixture.finish(successful);
    await vi.waitFor(() => expect(fixture.ledger.get(active.executionId)?.phase).toBe("succeeded"));
    expect(new WorkflowRunStore(fixture.db).get(runId)?.activeSteps.work).toBeDefined();

    const second = fixture.runtime("second");
    expect(await second.runtime.hydrate()).toContain(runId);
    const recovered = await second.runtime.wait(runId);
    expect(recovered.status).toBe("completed");
    expect(recovered.stepResults["work:0"]?.output).toBe("durable answer");
    expect(recovered.activeSteps).toEqual({});
    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(fixture.ledger.get(active.executionId)?.adapterExecution?.executionId).toBe("native-invocation");
  });

  it("preserves an uncertain execution after lease expiry without submitting another agent", async () => {
    const fixture = setup();
    const first = fixture.runtime("first");
    const runId = first.runtime.start("work");
    const active = await acknowledged(first.runtime, runId);
    first.runtime.shutdown();
    const priorHandle = await first.harness.reconcile(active.executionId);
    if (priorHandle.kind !== "running") throw new Error("Expected live completion");
    fixture.advance(60_001);
    const second = fixture.runtime("second");
    await second.runtime.hydrate();
    const recovered = second.runtime.status(runId)!;
    expect(recovered.status).toBe("recovery_required");
    expect(recovered.activeSteps.work).toMatchObject({ executionId: active.executionId, requestKey: active.requestKey });
    expect(fixture.run).toHaveBeenCalledTimes(1);
    fixture.finish(successful);
    expect((await priorHandle.running.completion).kind).toBe("ownership_lost");
    expect(fixture.ledger.get(active.executionId)?.phase).toBe("recovery_required");
  });

  it("retains recovery intent when a native success cannot be stored as JSON", async () => {
    const fixture = setup();
    const first = fixture.runtime("first");
    const runId = first.runtime.start("work");
    const active = await acknowledged(first.runtime, runId);
    fixture.finish({ ...successful, output: { kind: "structured", value: new Date() as unknown as string } });
    const final = await first.runtime.wait(runId);
    expect(final.status).toBe("recovery_required");
    expect(final.activeSteps.work?.runnerRef).toBe(active.executionId);
    expect(final.stepResults["work:0"]).toBeUndefined();
    expect(fixture.ledger.get(active.executionId)?.phase).toBe("recovery_required");
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });

  it("keeps cancellation unknown distinct from confirmed cancellation in both stores", async () => {
    const fixture = setup();
    const first = fixture.runtime("first");
    const runId = first.runtime.start("work");
    const active = await acknowledged(first.runtime, runId);
    first.runtime.cancel(runId, "operator request");
    expect(new WorkflowRunStore(fixture.db).get(runId)?.status).toBe("cancelling");
    expect(fixture.ledger.get(active.executionId)?.phase).toBe("cancel_requested");
    fixture.finish({ ok: false, harness: "codex", execution: successful.execution, conversation,
      failure: { kind: "cancelled_unknown", reason: "process stopped without native terminal evidence" }, usage: [] });
    const final = await first.runtime.wait(runId);
    expect(final.status).toBe("recovery_required");
    expect(final.activeSteps.work?.runnerRef).toBe(active.executionId);
    expect(fixture.ledger.get(active.executionId)?.phase).toBe("cancellation_unknown");
    expect(fixture.run).toHaveBeenCalledTimes(1);
  });
});
