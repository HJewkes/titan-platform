import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexExecCapabilities, createDurableHarnessDispatcher, type DurableHarnessSuccess, type HarnessAdapter, type HarnessRunResult } from "@titan-design/agent";
import { SqliteExecutionLedger, executionLedgerMigration } from "@titan-design/agent-lifecycle";
import { ATTEMPT_ID_PATTERN, TraceRecordSchema, type TraceRecord } from "@titan-design/agent-protocol/trace";
import { SqliteGateStore, gateMigration, gateResolverMigration, gateRuleMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { durableHarnessRunner } from "./durable-harness-runner.js";
import { inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration, workflowOwnershipMigration } from "./store.js";
import { projectRunTrace } from "./trace-projection.js";
import { workflowStepRequestKey, type RecoverableStepRunner, type WorkflowFn } from "./types.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

type Result = HarnessRunResult<never, "codex">;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const OWNER = { class: "owner-terminal" as const, id: "owner", channel: "terminal" };
const SUBJECT = { repo: "example/widgets", pr: "7", headSha: "a1b2c3" };
const conversation = { harness: "codex", namespace: "test", nativeId: "conversation" };
const execution = { executionId: "native-invocation", conversation };

function spent(responseId: string, usd: number): DurableHarnessSuccess["usage"][number] {
  return {
    kind: "delta", responseId, model: "test", source: "test", cost: { usd, kind: "estimate" },
    tokens: { input: 100, output: 10, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: null },
  };
}

/** A fake harness that fails its first call after spending and succeeds on the second. */
function flakyAdapter(): HarnessAdapter<"codex"> {
  const results: Result[] = [
    { ok: false, harness: "codex", execution, conversation, failure: { kind: "output_invalid", reason: "flaky" }, usage: [spent("r0", 0.02)] },
    { ok: true, harness: "codex", execution, conversation, output: { kind: "text", text: "built" }, usage: [spent("r1", 0.05)] },
  ];
  return {
    descriptor: codexExecCapabilities(),
    async run(request) {
      request.onProgress?.({ kind: "execution_started", harness: "codex", atMs: Date.now(), execution });
      return results.shift() ?? results[0]!;
    },
  };
}

/** The durable harness marks every failure final; this treats the first as retryable so the step retries over a real ledger. */
function retryingRunner(ledger: SqliteExecutionLedger<DurableHarnessSuccess<unknown, "codex">>): RecoverableStepRunner {
  const dispatcher = createDurableHarnessDispatcher(flakyAdapter(), { ledger, supervisorId: "supervisor", leaseMs: 60_000 });
  const inner = durableHarnessRunner(dispatcher, { request: () => ({
    harness: "codex", prompt: "build", cwd: "/tmp", target: { kind: "fresh", namespace: "test" }, wallTimeMs: 30_000, native: { model: "test" },
  }) });
  return {
    async dispatch(input) {
      const ack = await inner.dispatch(input);
      return { ...ack, completion: ack.completion.then((outcome) => (outcome.kind === "failed" && input.attempt === 0 ? { ...outcome, retryable: true } : outcome)) };
    },
    reconcile: (step, signal) => inner.reconcile(step, signal),
  };
}

function openStores(path: string) {
  const db = openDatabase(path);
  const gates = new SqliteGateStore(db, { migrate: false });
  const ledger = new SqliteExecutionLedger<DurableHarnessSuccess<unknown, "codex">>(db);
  return { db, gates, ledger };
}

function scratchDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "workflow-trace-restart-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runs.db");
  const db = openDatabase(path);
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4), gateRuleMigration(5), executionLedgerMigration(6)]);
  db.close();
  return path;
}

const flow: WorkflowFn = async (ctx) => {
  await ctx.dispatch("build", "build");
  await ctx.assisted("approve", "Ship the build?");
  await ctx.assisted("approve", "Ship the build?");
  await ctx.authorize("merge", { action: "merge", subject: SUBJECT });
};

async function answerWhenPending(gates: SqliteGateStore, runtime: WorkflowRuntime, runId: string, stepId: string, payload: Record<string, unknown>): Promise<void> {
  await vi.waitFor(() => expect(gates.listPending()).toHaveLength(1));
  runtime.signal(runId, stepId, payload, OWNER);
  await vi.waitFor(() => expect(gates.listPending()).toHaveLength(0));
}

/** Runs the flow to completion on a runtime over the file, projects it, and closes everything. */
async function runAndProject(path: string): Promise<{ runId: string; records: TraceRecord[] }> {
  const { db, gates, ledger } = openStores(path);
  const runtime = new WorkflowRuntime({ db, gates, runner: retryingRunner(ledger), gatePollMs: 5, authority: { actor: { class: "automation", id: "automation-1" } } });
  runtime.register("ship", flow);
  const runId = runtime.start("ship");
  await answerWhenPending(gates, runtime, runId, "approve", { signal: "revise", note: "smaller diff" });
  await answerWhenPending(gates, runtime, runId, "approve", { signal: "allow" });
  await answerWhenPending(gates, runtime, runId, "merge", { decision: "approve", subject: SUBJECT });
  const run = await runtime.wait(runId);
  const records = projectRunTrace(run, { gates, executions: ledger, digest });
  runtime.shutdown();
  db.close();
  return { runId, records };
}

function reprojectAfterRebuild(path: string, runId: string): TraceRecord[] {
  const { db, gates, ledger } = openStores(path);
  cleanups.push(() => db.close());
  const runtime = new WorkflowRuntime({ db, gates, runner: inlineRunner(() => "unused") });
  cleanups.push(() => runtime.shutdown());
  return projectRunTrace(runtime.status(runId)!, { gates, executions: ledger, digest });
}

describe("projectRunTrace across a rebuilt runtime", () => {
  it("projects JSON-byte-identical records from the same database", async () => {
    const path = scratchDb();
    const { runId, records } = await runAndProject(path);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2031-01-01T00:00:00.000Z") });

    const rebuilt = reprojectAfterRebuild(path, runId);

    expect(records.map((record) => record.kind)).toEqual(["run", "attempt", "attempt", "attempt", "gate", "attempt", "gate", "attempt", "gate", "gate"]);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(records));
  });

  it("emits strict records whose attempt ids follow the trace grammar", async () => {
    const path = scratchDb();
    const { runId } = await runAndProject(path);

    const records = reprojectAfterRebuild(path, runId);

    for (const record of records) expect(TraceRecordSchema.parse(record)).toEqual(record);
    const attemptIds = records.flatMap((record) => (record.kind === "attempt" ? [record.id] : "attemptId" in record && typeof record.attemptId === "string" ? [record.attemptId] : []));
    expect(attemptIds).toContain(workflowStepRequestKey(runId, "build", 0, 1));
    for (const id of attemptIds) expect(id).toMatch(ATTEMPT_ID_PATTERN);
  });
});

describe("workflowStepRequestKey grammar", () => {
  it("matches ATTEMPT_ID_PATTERN even when the run and step ids contain ':' and '/'", () => {
    const key = workflowStepRequestKey("run:1/a", "review:pr/7", 2, 1);

    expect(key).toMatch(ATTEMPT_ID_PATTERN);
    expect(key).toBe("workflow:run%3A1%2Fa:review%3Apr%2F7:2:1");
  });
});
