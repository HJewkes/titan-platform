import { SqliteGateStore, gateMigration } from "@titan-design/hitl";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import { WorkflowRunStore, workflowMigration, workflowOwnershipMigration } from "./store.js";
import type {
  DurableStepOutcome,
  RecoverableStepRunner,
  StepRunInput,
  StepRunOutcome,
  StepRunner,
  WorkflowEvent,
  WorkflowFn,
} from "./types.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3)]);
  return db;
}

function runtime(db: Db, runner: StepRunner, events: WorkflowEvent[] = [], extra: Partial<ConstructorParameters<typeof WorkflowRuntime>[0]> = {}): WorkflowRuntime {
  const gates = new SqliteGateStore(db, { migrate: false });
  return new WorkflowRuntime({ db, gates, runner, onEvent: (e) => events.push(e), gatePollMs: 10, ...extra });
}

const twoSteps: WorkflowFn = async (ctx) => {
  const plan = await ctx.dispatch("plan", "Plan {{brief}} for {{WORKFLOW_NAME}}");
  await ctx.dispatch("review", "Review:\n{{STEP_OUTPUT_PLAN}}", { model: "haiku" });
  if (plan.signal === "needs_revision") await ctx.dispatch("plan", "Revise");
};

describe("WorkflowRuntime", () => {
  it("runs dispatch steps through the runner with rendered prompts and parses signals", async () => {
    const db = makeDb();
    const seen: StepRunInput[] = [];
    const runner = inlineRunner((input) => {
      seen.push(input);
      if (input.stepId === "plan") return input.iteration === 0 ? "a plan\n<!-- signal: needs_revision -->" : "a revised plan";
      return "looks good";
    });
    const events: WorkflowEvent[] = [];
    const rt = runtime(db, runner, events);
    rt.register("demo", twoSteps);
    const runId = rt.start("demo", { brief: "ship it" });
    const run = await rt.wait(runId);

    expect(run.status).toBe("completed");
    expect(seen.map((s) => `${s.stepId}:${s.iteration}`)).toEqual(["plan:0", "review:0", "plan:1"]);
    expect(seen[0]!.prompt).toBe("Plan ship it for demo");
    expect(seen[1]!.prompt).toContain("a plan");
    expect(seen[1]!.model).toBe("haiku");
    expect(run.stepResults["plan:0"]).toMatchObject({ signal: "needs_revision", iteration: 0 });
    expect(run.stepResults["plan:1"]).toMatchObject({ signal: null, iteration: 1 });
    expect(events.map((e) => e.type)).toEqual(["step_started", "step_complete", "step_started", "step_complete", "step_started", "step_complete", "workflow_complete"]);
    expect(rt.status(runId)?.status).toBe("completed");
  });

  it("retries a retryable failure once and then fails the run", async () => {
    const db = makeDb();
    let calls = 0;
    const flaky: StepRunner = { run: async () => ({ ok: false, error: `boom ${++calls}`, retryable: true }) };
    const events: WorkflowEvent[] = [];
    const rt = runtime(db, flaky, events);
    rt.register("flaky", async (ctx) => {
      await ctx.dispatch("only", "x");
    });
    const run = await rt.wait(rt.start("flaky"));
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/step only \(iteration 0\) failed: boom 2/);
    expect(calls).toBe(2);
    expect(events.filter((e) => e.type === "step_retry")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "workflow_failed" });
  });

  it("seeds merge data into params and memoize by step id", async () => {
    const db = makeDb();
    const seed = vi.fn(async () => ({ data: { planId: "P-1" }, output: "seeded" }));
    const rt = runtime(db, inlineRunner((i) => `got ${i.prompt}`));
    rt.register("seeded", async (ctx) => {
      await ctx.seed("seed", seed);
      await ctx.seed("seed", seed);
      await ctx.dispatch("use", "plan {{PLAN_ID}} / {{planId}}");
    });
    const run = await rt.wait(rt.start("seeded"));
    expect(seed).toHaveBeenCalledTimes(1);
    expect(run.params.planId).toBe("P-1");
    expect(run.stepResults["use:0"]?.output).toBe("got plan P-1 / P-1");
  });

  it("pauses on an assisted step as a durable gate and resumes when signalled from outside", async () => {
    const db = makeDb();
    const events: WorkflowEvent[] = [];
    const rt = runtime(db, inlineRunner(() => "ok"), events);
    rt.register("gated", async (ctx) => {
      await ctx.dispatch("draft", "draft");
      const answer = await ctx.assisted("approve", "Approve the draft?");
      if (answer.signal === "approved") await ctx.dispatch("ship", "ship");
    });
    const runId = rt.start("gated");
    await vi.waitFor(() => expect(rt.status(runId)?.status).toBe("paused"));
    expect(events.find((e) => e.type === "gate_opened")).toMatchObject({ gateId: `${runId}/approve` });

    rt.signal(runId, "approve", { signal: "approved", by: "reviewer" });
    const run = await rt.wait(runId);
    expect(run.status).toBe("completed");
    expect(run.stepResults.approve).toMatchObject({ signal: "approved", data: { signal: "approved", by: "reviewer" } });
    expect(run.stepResults["ship:0"]).toBeDefined();
  });

  it("replays a paused run after a restart without re-running finished steps", async () => {
    const db = makeDb();
    const first = runtime(db, inlineRunner(() => "drafted"));
    const gated: WorkflowFn = async (ctx) => {
      await ctx.dispatch("draft", "draft");
      await ctx.assisted("approve", "ok?");
      await ctx.dispatch("ship", "ship");
    };
    first.register("gated", gated);
    const runId = first.start("gated");
    await vi.waitFor(() => expect(first.status(runId)?.status).toBe("paused"));
    first.shutdown();
    expect(first.status(runId)?.status).toBe("paused");

    const dispatched: string[] = [];
    const second = runtime(db, inlineRunner((i) => {
      dispatched.push(i.stepId);
      return "shipped";
    }));
    second.register("gated", gated);
    expect(await second.hydrate()).toEqual([runId]);
    await vi.waitFor(() => expect(second.status(runId)?.currentStep).toBe("approve"));
    second.signal(runId, "approve", {});
    const run = await second.wait(runId);
    expect(run.status).toBe("completed");
    expect(dispatched).toEqual(["ship"]);
    expect(run.stepResults["draft:0"]?.output).toBe("drafted");
  });

  it("cancels a running workflow: the runner's signal fires and the run is marked cancelled", async () => {
    const db = makeDb();
    const runner: StepRunner = {
      run: (input) =>
        new Promise((resolve) => {
          input.signal.addEventListener("abort", () => resolve({ ok: false, error: "aborted", retryable: false }));
        }),
    };
    const events: WorkflowEvent[] = [];
    const rt = runtime(db, runner, events);
    rt.register("slow", async (ctx) => {
      await ctx.dispatch("wait", "wait");
    });
    const runId = rt.start("slow");
    await vi.waitFor(() => expect(events.some((e) => e.type === "step_started")).toBe(true));
    rt.cancel(runId, "operator stopped it");
    const run = await rt.wait(runId);
    expect(run).toMatchObject({ status: "cancelled", error: "operator stopped it" });
    expect(rt.list(["cancelled"]).map((r) => r.id)).toEqual([runId]);
  });

  it("reconciles a durable terminal outcome without dispatching again", async () => {
    const db = makeDb();
    const firstRunner: RecoverableStepRunner = {
      dispatch: async (input) => ({ executionId: input.executionId, requestKey: input.requestKey, runnerRef: "execution-1", completion: new Promise(() => undefined) }),
      reconcile: async () => ({ kind: "unknown", evidence: "not used before restart" }),
    };
    const first = runtime(db, firstRunner, [], { executionId: () => "execution-1" });
    const wf: WorkflowFn = async (ctx) => {
      await ctx.dispatch("long", "long");
    };
    first.register("wf", wf);
    const runId = first.start("wf");
    await vi.waitFor(() => expect(first.status(runId)?.activeSteps.long).toBeDefined());
    first.shutdown();

    const dispatch = vi.fn();
    const attaching: RecoverableStepRunner = {
      dispatch,
      reconcile: async () => ({
        kind: "terminal",
        outcome: { kind: "succeeded", output: "finished while we were down\n<!-- signal: approved -->" },
        evidence: "ledger terminal",
      }),
    };
    const second = runtime(db, attaching);
    second.register("wf", wf);
    await second.hydrate();
    const run = await second.wait(runId);
    expect(run.status).toBe("completed");
    expect(run.stepResults["long:0"]).toMatchObject({ output: expect.stringContaining("finished"), signal: "approved" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("persists a recoverable dispatch acknowledgement before completion", async () => {
    const db = makeDb();
    const completion = deferred<DurableStepOutcome>();
    const runner: RecoverableStepRunner = {
      dispatch: async (input) => ({
        executionId: input.executionId,
        requestKey: input.requestKey,
        runnerRef: "runner-17",
        completion: completion.promise,
      }),
      reconcile: async () => ({ kind: "unknown", evidence: "not used" }),
    };
    const rt = runtime(db, runner, [], { executionId: () => "execution-17" });
    rt.register("durable", oneDispatch);
    const runId = rt.start("durable");

    await vi.waitFor(() => expect(new WorkflowRunStore(db).get(runId)?.activeSteps.work).toMatchObject({
      kind: "recoverable",
      executionId: "execution-17",
      requestKey: expect.stringContaining(encodeURIComponent(runId)),
      runnerRef: "runner-17",
    }));
    completion.resolve({ kind: "succeeded", output: "done" });
    expect(await rt.wait(runId)).toMatchObject({ status: "completed", stepResults: { "work:0": { output: "done" } } });
  });

  it("keeps deprecated legacy attach working when it returns a terminal success", async () => {
    const db = makeDb();
    const first = runtime(db, { run: () => new Promise<StepRunOutcome>(() => undefined) });
    first.register("legacy", oneDispatch);
    const runId = first.start("legacy");
    await vi.waitFor(() => expect(first.status(runId)?.activeSteps.work).toBeDefined());
    first.shutdown();

    const run = vi.fn(async () => ({ ok: true as const, output: "must not redispatch" }));
    const second = runtime(db, { run, attach: async () => ({ ok: true, output: "attached result" }) });
    second.register("legacy", oneDispatch);
    expect(await second.hydrate()).toEqual([runId]);
    expect(await second.wait(runId)).toMatchObject({ status: "completed", stepResults: { "work:0": { output: "attached result" } } });
    expect(run).not.toHaveBeenCalled();
  });

  it("requires recovery for a legacy step that cannot attach after restart", async () => {
    const { db, runId } = await abandonedLegacyRun();
    const run = vi.fn(async () => ({ ok: true as const, output: "unsafe duplicate" }));
    const second = runtime(db, { run });
    second.register("legacy", oneDispatch);

    expect(await second.hydrate()).toEqual([]);
    expect(second.status(runId)).toMatchObject({
      status: "recovery_required",
      activeSteps: { work: { recovery: { kind: "legacy_unrecoverable" } } },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("bounds a hanging legacy attach and persists recovery_required", async () => {
    const { db, runId } = await abandonedLegacyRun();
    const attach = vi.fn(() => new Promise<StepRunOutcome>(() => undefined));
    const second = runtime(db, { run: async () => ({ ok: true, output: "unsafe" }), attach }, [], { reconcileTimeoutMs: 10 });
    second.register("legacy", oneDispatch);

    expect(await second.hydrate()).toEqual([]);
    expect(second.status(runId)).toMatchObject({ status: "recovery_required", error: expect.stringContaining("timed out") });
    expect(attach).toHaveBeenCalledOnce();
  });

  it("bounds a hanging durable reconciliation without dispatching", async () => {
    const { db, runId } = await abandonedRecoverableRun();
    const dispatch = vi.fn();
    const second = runtime(db, {
      dispatch,
      reconcile: () => new Promise(() => undefined),
    }, [], { reconcileTimeoutMs: 10 });
    second.register("durable", oneDispatch);

    expect(await second.hydrate()).toEqual([]);
    expect(second.status(runId)).toMatchObject({ status: "recovery_required", error: expect.stringContaining("timed out") });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not redispatch an unknown recoverable execution", async () => {
    const { db, runId } = await abandonedRecoverableRun();
    const dispatch = vi.fn();
    const second = runtime(db, {
      dispatch,
      reconcile: async () => ({ kind: "unknown", evidence: "ledger unavailable" }),
    });
    second.register("durable", oneDispatch);

    expect(await second.hydrate()).toEqual([]);
    expect(second.status(runId)).toMatchObject({
      status: "recovery_required",
      activeSteps: { work: { recovery: { kind: "unknown", evidence: "ledger unavailable" } } },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("can reconcile a recovery_required execution on a later hydrate", async () => {
    const { db, runId } = await abandonedRecoverableRun();
    const unavailable = runtime(db, {
      dispatch: async () => { throw new Error("must not redispatch"); },
      reconcile: async () => ({ kind: "unknown", evidence: "ledger temporarily unavailable" }),
    });
    unavailable.register("durable", oneDispatch);
    await unavailable.hydrate();
    expect(unavailable.status(runId)?.status).toBe("recovery_required");

    const restored = runtime(db, {
      dispatch: async () => { throw new Error("must not redispatch"); },
      reconcile: async () => ({
        kind: "terminal",
        outcome: { kind: "succeeded", output: "read after recovery" },
        evidence: "ledger restored",
      }),
    });
    restored.register("durable", oneDispatch);
    expect(await restored.hydrate()).toEqual([runId]);
    expect(await restored.wait(runId)).toMatchObject({
      status: "completed",
      error: null,
      stepResults: { "work:0": { output: "read after recovery" } },
    });
  });

  it("retries not_found only when the runner provides retry-safe evidence", async () => {
    const { db, runId } = await abandonedRecoverableRun();
    const dispatch = vi.fn(async (input) => ({
      executionId: input.executionId,
      requestKey: input.requestKey,
      runnerRef: "replacement-runner",
      completion: Promise.resolve({ kind: "succeeded" as const, output: "replacement result" }),
    }));
    const second = runtime(db, {
      dispatch,
      reconcile: async () => ({ kind: "not_found", retrySafe: true, evidence: "durable absence proof" }),
    }, [], { executionId: () => "replacement-execution" });
    second.register("durable", oneDispatch);

    expect(await second.hydrate()).toEqual([runId]);
    expect(await second.wait(runId)).toMatchObject({ status: "completed" });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      executionId: "replacement-execution",
      requestKey: expect.stringMatching(/:1$/),
    }));
  });

  it("keeps the retry limit across restart boundaries", async () => {
    const { db, runId } = await abandonedRecoverableRun();
    const second = runtime(db, {
      dispatch: async (input) => ({
        executionId: input.executionId,
        requestKey: input.requestKey,
        runnerRef: "retry-runner",
        completion: new Promise(() => undefined),
      }),
      reconcile: async () => ({
        kind: "terminal",
        outcome: { kind: "failed", error: "attempt zero failed", retryable: true },
        evidence: "ledger terminal",
      }),
    }, [], { executionId: () => "retry-execution", maxRetries: 1 });
    second.register("durable", oneDispatch);
    await second.hydrate();
    await vi.waitFor(() => expect(second.status(runId)?.activeSteps.work).toMatchObject({ attempt: 1, executionId: "retry-execution" }));
    second.shutdown();

    const dispatch = vi.fn();
    const third = runtime(db, {
      dispatch,
      reconcile: async () => ({
        kind: "terminal",
        outcome: { kind: "failed", error: "attempt one failed", retryable: true },
        evidence: "ledger terminal",
      }),
    }, [], { maxRetries: 1 });
    third.register("durable", oneDispatch);
    await third.hydrate();

    expect(await third.wait(runId)).toMatchObject({ status: "failed", error: expect.stringContaining("attempt one failed") });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("lets only one runtime reconcile a persisted execution", async () => {
    const { db, runId } = await abandonedRecoverableRun();
    const reconciliation = deferred<DurableStepOutcome>();
    const reconcileStarted = deferred<void>();
    const runner: RecoverableStepRunner = {
      dispatch: async () => { throw new Error("must not redispatch"); },
      reconcile: async () => {
        reconcileStarted.resolve();
        return { kind: "terminal", outcome: await reconciliation.promise, evidence: "ledger terminal" };
      },
    };
    const second = runtime(db, runner, [], { runtimeId: "runtime-two" });
    const third = runtime(db, runner, [], { runtimeId: "runtime-three" });
    second.register("durable", oneDispatch);
    third.register("durable", oneDispatch);
    const secondHydrate = second.hydrate();
    await reconcileStarted.promise;

    expect(await third.hydrate()).toEqual([]);
    reconciliation.resolve({ kind: "succeeded", output: "once" });
    expect(await secondHydrate).toEqual([runId]);
    expect(await second.wait(runId)).toMatchObject({ status: "completed" });
  });

  it("prevents a shutdown completion from writing through its released fence", async () => {
    const db = makeDb();
    const completion = deferred<DurableStepOutcome>();
    const first = runtime(db, pendingRecoverable(completion.promise), [], { runtimeId: "old-runtime", executionId: () => "execution-old" });
    first.register("durable", oneDispatch);
    const runId = first.start("durable");
    await vi.waitFor(() => expect(first.status(runId)?.activeSteps.work?.runnerRef).toBe("execution-old"));
    first.shutdown();

    const second = runtime(db, {
      dispatch: async () => { throw new Error("must not redispatch"); },
      reconcile: async () => ({ kind: "unknown", evidence: "manual inspection required" }),
    }, [], { runtimeId: "new-runtime" });
    second.register("durable", oneDispatch);
    await second.hydrate();
    completion.resolve({ kind: "succeeded", output: "late stale success" });

    await vi.waitFor(() => expect(new WorkflowRunStore(db).get(runId)).toMatchObject({
      status: "recovery_required",
      stepResults: {},
      activeSteps: { work: { recovery: { evidence: "manual inspection required" } } },
    }));
  });

  it("preserves the active intent when the result memoization write fails", async () => {
    const db = makeDb();
    const completion = deferred<DurableStepOutcome>();
    const rt = runtime(db, pendingRecoverable(completion.promise), [], { executionId: () => "execution-persist" });
    rt.register("durable", oneDispatch);
    const runId = rt.start("durable");
    await vi.waitFor(() => expect(rt.status(runId)?.activeSteps.work?.runnerRef).toBe("execution-persist"));
    const original = WorkflowRunStore.prototype.save;
    const save = vi.spyOn(WorkflowRunStore.prototype, "save").mockImplementationOnce(() => {
      throw new Error("temporary database failure");
    }).mockImplementation(original);

    completion.resolve({ kind: "succeeded", output: "observed but not committed" });
    const run = await rt.wait(runId);
    save.mockRestore();

    expect(run).toMatchObject({
      status: "recovery_required",
      stepResults: {},
      activeSteps: { work: { executionId: "execution-persist", recovery: { kind: "unknown" } } },
    });
  });

  it("does not adopt a takeover owner's fence while handling a stale persistence failure", async () => {
    const db = makeDb();
    const completion = deferred<DurableStepOutcome>();
    const rt = runtime(db, pendingRecoverable(completion.promise), [], {
      runtimeId: "old-runtime",
      executionId: () => "execution-takeover",
    });
    rt.register("durable", oneDispatch);
    const runId = rt.start("durable");
    await vi.waitFor(() => expect(rt.status(runId)?.activeSteps.work?.runnerRef).toBe("execution-takeover"));
    const original = WorkflowRunStore.prototype.save;
    const save = vi.spyOn(WorkflowRunStore.prototype, "save").mockImplementationOnce(() => {
      db.prepare("UPDATE workflow_run SET owner_lease_until = ? WHERE id = ?").run(new Date(0).toISOString(), runId);
      const now = new Date().toISOString();
      const lease = new Date(Date.now() + 60_000).toISOString();
      expect(new WorkflowRunStore(db).claim(runId, "new-runtime", lease, now)).toBeDefined();
      throw new Error("old owner write failed");
    }).mockImplementation(original);

    completion.resolve({ kind: "succeeded", output: "stale result" });
    const run = await rt.wait(runId);
    save.mockRestore();

    expect(run).toMatchObject({
      status: "running",
      owner: { runtimeId: "new-runtime", generation: 2 },
      stepResults: {},
      activeSteps: { work: { executionId: "execution-takeover" } },
    });
  });

  it("waits for concurrent dispatches before terminalizing after a sibling failure", async () => {
    const db = makeDb();
    const first = deferred<DurableStepOutcome>();
    const second = deferred<DurableStepOutcome>();
    const runner: RecoverableStepRunner = {
      dispatch: async (input) => ({
        executionId: input.executionId,
        requestKey: input.requestKey,
        runnerRef: input.stepId,
        completion: input.stepId === "first" ? first.promise : second.promise,
      }),
      reconcile: async () => ({ kind: "unknown", evidence: "not used" }),
    };
    const rt = runtime(db, runner);
    rt.register("parallel", async (ctx) => {
      await Promise.all([ctx.dispatch("first", "first"), ctx.dispatch("second", "second")]);
    });
    const runId = rt.start("parallel");
    await vi.waitFor(() => expect(Object.keys(rt.status(runId)?.activeSteps ?? {})).toHaveLength(2));

    first.resolve({ kind: "failed", error: "first failed", retryable: false });
    await vi.waitFor(() => expect(new WorkflowRunStore(db).get(runId)).toMatchObject({
      status: "running",
      activeSteps: { second: { runnerRef: "second" } },
    }));
    second.resolve({ kind: "succeeded", output: "second finished" });

    expect(await rt.wait(runId)).toMatchObject({
      status: "failed",
      activeSteps: {},
      stepResults: { "second:0": { output: "second finished" } },
    });
  });

  it("persists cancellation intent before abort and retains an unknown cancellation for recovery", async () => {
    const db = makeDb();
    const completion = deferred<DurableStepOutcome>();
    const rt = runtime(db, pendingRecoverable(completion.promise), [], { executionId: () => "execution-cancel" });
    rt.register("durable", oneDispatch);
    const runId = rt.start("durable");
    await vi.waitFor(() => expect(rt.status(runId)?.activeSteps.work?.runnerRef).toBe("execution-cancel"));

    rt.cancel(runId, "operator requested cancellation");
    expect(new WorkflowRunStore(db).get(runId)?.status).toBe("cancelling");
    completion.resolve({ kind: "cancellation_unknown", reason: "runner could not confirm process exit" });

    expect(await rt.wait(runId)).toMatchObject({
      status: "recovery_required",
      activeSteps: { work: { recovery: { kind: "unknown", evidence: "runner could not confirm process exit" } } },
    });
  });

  it("stores a natural success observed after cancellation before finalizing cancelled", async () => {
    const db = makeDb();
    const completion = deferred<DurableStepOutcome>();
    const rt = runtime(db, pendingRecoverable(completion.promise), [], { executionId: () => "execution-race" });
    rt.register("durable", oneDispatch);
    const runId = rt.start("durable");
    await vi.waitFor(() => expect(rt.status(runId)?.activeSteps.work?.runnerRef).toBe("execution-race"));

    rt.cancel(runId, "cancel raced with completion");
    completion.resolve({ kind: "succeeded", output: "completed before cancellation took effect" });

    expect(await rt.wait(runId)).toMatchObject({
      status: "cancelled",
      error: "cancel raced with completion",
      stepResults: { "work:0": { output: "completed before cancellation took effect" } },
    });
  });

  it("marks an unsolicited definite runner cancellation as cancelled", async () => {
    const db = makeDb();
    const completion = deferred<DurableStepOutcome>();
    const rt = runtime(db, pendingRecoverable(completion.promise), [], { executionId: () => "execution-runner-cancel" });
    rt.register("durable", oneDispatch);
    const runId = rt.start("durable");
    completion.resolve({ kind: "cancelled", reason: "runner terminated the execution" });

    expect(await rt.wait(runId)).toMatchObject({ status: "cancelled", error: "runner terminated the execution" });
  });

  it("leaves a completed workflow unchanged when cancellation arrives late", async () => {
    const db = makeDb();
    const rt = runtime(db, inlineRunner(() => "done"));
    rt.register("complete", oneDispatch);
    const runId = rt.start("complete");
    const before = await rt.wait(runId);

    rt.cancel(runId, "too late");

    expect(rt.status(runId)).toMatchObject({ status: "completed", completedAt: before.completedAt, error: null });
  });

  it("does not cancel gates when cancellation intent cannot be persisted", async () => {
    const db = makeDb();
    const rt = runtime(db, inlineRunner(() => "unused"));
    rt.register("gated-cancel", async (ctx) => { await ctx.assisted("approval", "approve?"); });
    const runId = rt.start("gated-cancel");
    await vi.waitFor(() => expect(rt.status(runId)?.status).toBe("paused"));
    const save = vi.spyOn(WorkflowRunStore.prototype, "save").mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });

    expect(() => rt.cancel(runId, "stop")).toThrow(/persistence failed/);
    expect(new SqliteGateStore(db, { migrate: false }).listPending().map((gate) => gate.id)).toContain(`${runId}/approval`);
    save.mockRestore();
    rt.shutdown();
  });

  it("keeps the reconcile signal connected to workflow cancellation while completion is running", async () => {
    const { db, runId } = await abandonedRecoverableRun();
    const cancellationObserved = deferred<void>();
    const second: RecoverableStepRunner = {
      dispatch: async () => { throw new Error("must not redispatch"); },
      reconcile: async (step, signal) => ({
        kind: "running",
        runnerRef: step.runnerRef ?? "runner",
        evidence: "still running",
        completion: new Promise((resolve) => signal.addEventListener("abort", () => {
          cancellationObserved.resolve();
          resolve({ kind: "cancelled", reason: String(signal.reason) });
        }, { once: true })),
      }),
    };
    const rt = runtime(db, second);
    rt.register("durable", oneDispatch);
    expect(await rt.hydrate()).toEqual([runId]);

    rt.cancel(runId, "stop recovered work");
    await cancellationObserved.promise;
    expect(await rt.wait(runId)).toMatchObject({ status: "cancelled", error: "stop recovered work" });
  });
});

const oneDispatch: WorkflowFn = async (ctx) => {
  await ctx.dispatch("work", "work");
};

async function abandonedLegacyRun(): Promise<{ db: Db; runId: string }> {
  const db = makeDb();
  const first = runtime(db, { run: () => new Promise<StepRunOutcome>(() => undefined) });
  first.register("legacy", oneDispatch);
  const runId = first.start("legacy");
  await vi.waitFor(() => expect(first.status(runId)?.activeSteps.work).toBeDefined());
  first.shutdown();
  return { db, runId };
}

async function abandonedRecoverableRun(): Promise<{ db: Db; runId: string }> {
  const db = makeDb();
  const first = runtime(db, pendingRecoverable(new Promise<DurableStepOutcome>(() => undefined)), [], {
    executionId: () => "original-execution",
  });
  first.register("durable", oneDispatch);
  const runId = first.start("durable");
  await vi.waitFor(() => expect(first.status(runId)?.activeSteps.work?.runnerRef).toBe("original-execution"));
  first.shutdown();
  return { db, runId };
}

function pendingRecoverable(completion: Promise<DurableStepOutcome>): RecoverableStepRunner {
  return {
    dispatch: async (input) => ({
      executionId: input.executionId,
      requestKey: input.requestKey,
      runnerRef: input.executionId,
      completion,
    }),
    reconcile: async () => ({ kind: "unknown", evidence: "not used" }),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
