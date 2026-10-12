import { createHash } from "node:crypto";
import type { ExecutionRecord, UsageMeasurement } from "@titan-design/agent-protocol";
import { TraceRecordSchema, type TraceAttempt, type TraceRecord } from "@titan-design/agent-protocol/trace";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration } from "./store.js";
import { projectRunTrace, type RunTraceSources } from "./trace-projection.js";
import type { DurableStepOutcome, RecoverableStepRunner, StepRunner, StepRunOutcome, WorkflowFn, WorkflowRun } from "./types.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const noGates: RunTraceSources["gates"] = { get: () => undefined };
const conversation = { harness: "codex", namespace: "test", nativeId: "conversation-1" };
const RAW = { prompt: "PROMPT-TEXT-7f3a", output: "OUTPUT-TEXT-9b2c", param: "PARAM-TEXT-4d1e" };

function spent(responseId: string, usd: number, input: number, output: number): UsageMeasurement {
  return {
    kind: "delta", responseId, model: "test", source: "test", cost: { usd, kind: "estimate" },
    tokens: { input, output, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: null },
  };
}

/** A recoverable runner that fails attempt 0 retryably and succeeds on attempt 1, writing each attempt to a ledger. */
function flakyDurableRunner(ledger: Map<string, ExecutionRecord>): RecoverableStepRunner {
  return {
    async dispatch(input) {
      const at = `2026-10-12T00:00:0${input.attempt}.000Z`;
      const base = { execution: { executionId: input.executionId }, harness: "codex", requestKey: input.requestKey, target: { kind: "fresh" as const, namespace: "test" }, revision: 3, ownerGeneration: 1, runnerRef: `ref-${input.attempt}`, preparedAt: at, dispatchedAt: at, finishedAt: at, lastObservedAt: at };
      const first = input.attempt === 0;
      const terminal: ExecutionRecord["terminal"] = first
        ? { outcome: "failed", reason: "flaky", retryable: true, usage: [spent("r0", 0.02, 100, 10)] }
        : { outcome: "succeeded", result: { conversation, usage: [spent("r1", 0.05, 400, 30)] } };
      ledger.set(input.requestKey, { ...base, phase: first ? "failed" : "succeeded", terminal });
      const completion: DurableStepOutcome = first
        ? { kind: "failed", error: "flaky", retryable: true, usage: { costUsd: 0.02, inputTokens: 100, outputTokens: 10 } }
        : { kind: "succeeded", output: RAW.output, usage: { costUsd: 0.05, inputTokens: 400, outputTokens: 30 } };
      return { executionId: input.executionId, requestKey: input.requestKey, runnerRef: `ref-${input.attempt}`, completion: Promise.resolve(completion) };
    },
    async reconcile() { throw new Error("not reconciled in this test"); },
  };
}

function flakyLegacyRunner(): StepRunner {
  let calls = 0;
  return {
    async run(): Promise<StepRunOutcome> {
      calls += 1;
      return calls === 1
        ? { ok: false, error: "flaky", retryable: true, usage: { costUsd: 0.01 } }
        : { ok: true, output: RAW.output, usage: { costUsd: 0.03, inputTokens: 50 } };
    },
  };
}

async function runOnce(runner: StepRunner, workflow: WorkflowFn): Promise<{ run: WorkflowRun; sources: Omit<RunTraceSources, "executions"> }> {
  const db = openDatabase(":memory:");
  cleanups.push(() => db.close());
  runMigrations(db, [gateMigration(1), workflowMigration(2), gateResolverMigration(3)]);
  const gates = new SqliteGateStore(db, { migrate: false });
  const runtime = new WorkflowRuntime({ db, gates, runner });
  cleanups.push(() => runtime.shutdown());
  runtime.register("work", workflow);
  const run = await runtime.wait(runtime.start("work", { secret: RAW.param }));
  return { run, sources: { gates, digest } };
}

const work: WorkflowFn = async (ctx) => void (await ctx.dispatch("work", `${RAW.prompt} {{secret}}`));

function attempts(records: TraceRecord[]): TraceAttempt[] {
  return records.filter((record): record is TraceAttempt => record.kind === "attempt");
}

function storedRun(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: "run-1", workflowName: "work", params: { secret: RAW.param }, status: "completed", currentStep: null, stepResults: {}, activeSteps: {},
    revision: 1, ownerGeneration: 1, startedAt: "2026-10-12T00:00:00.000Z", completedAt: "2026-10-12T00:01:00.000Z", error: null, ...overrides,
  };
}

describe("projectRunTrace on a durable step that retries then succeeds", () => {
  it("emits one attempt per ledger attempt, each with its own usage and phase", async () => {
    const ledger = new Map<string, ExecutionRecord>();
    const { run, sources } = await runOnce(flakyDurableRunner(ledger), work);

    const records = projectRunTrace(run, { ...sources, executions: { findByRequestKey: (key) => ledger.get(key) } });

    expect(records[0]).toMatchObject({ kind: "run", id: run.id, status: "completed", paramsSha256: digest(JSON.stringify({ secret: RAW.param })) });
    const [failed, succeeded] = attempts(records);
    expect(attempts(records)).toHaveLength(2);
    expect(failed).toMatchObject({ id: expect.stringMatching(/:0$/), attempt: 0, phase: "failed", outcome: "failed", retryable: true, runnerRef: "ref-0", usage: { costUsd: 0.02, inputTokens: 100, outputTokens: 10 } });
    expect(failed).not.toHaveProperty("outputSha256");
    expect(succeeded).toMatchObject({
      id: expect.stringMatching(/:1$/), attempt: 1, phase: "succeeded", outcome: "succeeded", runnerRef: "ref-1",
      conversation: "conversation:codex:test:conversation-1", usage: { costUsd: 0.05, inputTokens: 400, outputTokens: 30 }, outputSha256: digest(RAW.output),
    });
  });

  it("records the final attempt on the step result", async () => {
    const { run } = await runOnce(flakyDurableRunner(new Map()), work);

    expect(run.stepResults["work:0"]?.attempt).toBe(1);
  });
});

describe("projectRunTrace without a ledger", () => {
  it("names a legacy runner's retried step by the attempt that succeeded", async () => {
    const { run, sources } = await runOnce(flakyLegacyRunner(), work);

    const projected = attempts(projectRunTrace(run, sources));

    expect(run.stepResults["work:0"]?.attempt).toBe(1);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ id: `workflow:${run.id}:work:0:1`, attempt: 1, stepKind: "dispatch", outcome: "succeeded", usage: { costUsd: 0.04, inputTokens: 50 } });
  });

  it("projects seed and assisted results at attempt 0", () => {
    const run = storedRun({ stepResults: {
      "plan:0": { stepId: "plan", iteration: 0, operation: "seed", agentId: null, signal: null, completedAt: "2026-10-12T00:00:10.000Z", output: "seeded", data: { a: "b" } },
      "approve:0": { stepId: "approve", iteration: 0, operation: "assisted", agentId: null, signal: "allow", completedAt: "2026-10-12T00:00:20.000Z", data: { signal: "allow" } },
    } });

    const projected = attempts(projectRunTrace(run, { gates: noGates, digest }));

    expect(projected.map((attempt) => [attempt.id, attempt.stepKind, attempt.at])).toEqual([
      ["workflow:run-1:plan:0:0", "seed", "2026-10-12T00:00:10.000Z"],
      ["workflow:run-1:approve:0:0", "assisted", "2026-10-12T00:00:20.000Z"],
    ]);
  });

  it("projects an in-flight step without its recovery evidence", () => {
    const run = storedRun({ status: "recovery_required", completedAt: null, activeSteps: { work: {
      kind: "recoverable", stepId: "work", iterKey: "work:2", attempt: 0, startedAt: "2026-10-12T00:00:30.000Z", executionId: "exec-1", requestKey: "workflow:run-1:work:2:0",
      recovery: { kind: "unknown", evidence: "EVIDENCE-TEXT-5a6b", observedAt: "2026-10-12T00:00:40.000Z" },
    } } });

    const records = projectRunTrace(run, { gates: noGates, digest });

    expect(attempts(records)).toEqual([expect.objectContaining({ id: "workflow:run-1:work:2:0", executionId: "exec-1", recovery: { kind: "unknown", observedAt: "2026-10-12T00:00:40.000Z" } })]);
    expect(JSON.stringify(records)).not.toContain("EVIDENCE-TEXT");
  });
});

describe("projectRunTrace records", () => {
  it("each pass the strict trace schema and carry no raw prompt, output or params text", async () => {
    const ledger = new Map<string, ExecutionRecord>();
    const { run, sources } = await runOnce(flakyDurableRunner(ledger), work);

    const records = projectRunTrace(run, { ...sources, executions: { findByRequestKey: (key) => ledger.get(key) } });

    for (const record of records) expect(TraceRecordSchema.parse(record)).toEqual(record);
    const text = JSON.stringify(records);
    for (const raw of Object.values(RAW)) expect(text).not.toContain(raw);
  });

  it("drop costUnknown, which the strict attempt usage refuses", () => {
    const run = storedRun({ stepResults: {
      "work:0": { stepId: "work", iteration: 0, operation: "dispatch", agentId: "agent-1", signal: null, completedAt: "2026-10-12T00:00:10.000Z", usage: { costUsd: 0.1, costUnknown: true } },
    } });

    const [, attempt] = projectRunTrace(run, { gates: noGates, digest });

    expect(attempt).toMatchObject({ kind: "attempt", usage: { costUsd: 0.1 } });
  });
});
