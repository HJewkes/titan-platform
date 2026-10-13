import { createHash } from "node:crypto";
import { TraceRecordSchema, type TraceGate, type TraceRecord } from "@titan-design/agent-protocol/trace";
import type { ActorClass } from "@titan-design/authority";
import type { GateRecord } from "@titan-design/hitl";
import { SqliteGateStore, gateMigration, gateResolverMigration, gateRuleMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistedGateId } from "./gate-ids.js";
import { TRACE_ARTIFACTS_KEY } from "./index.js";
import { inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration, workflowOwnershipMigration } from "./store.js";
import { projectRunTrace, type RunTraceSources } from "./trace-projection.js";
import type { StepResult, WorkflowFn, WorkflowRun } from "./types.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const OWNER = { class: "owner-terminal" as const, id: "owner", channel: "terminal" };
const SUBJECT = { repo: "example/widgets", pr: "7", headSha: "a1b2c3" };
const RAW = { prompt: "GATE-PROMPT-3c8d", answer: "GATE-ANSWER-6e1f" };
const PR_ARTIFACT = { schema: "titan.trace/v1", kind: "artifact", id: "pr:example/widgets#7", runId: "run-1", at: "2026-10-12T00:00:10.000Z", artifactKind: "pr", repo: "example/widgets", number: 7, state: "open" };

function host(actor: ActorClass = "owner-terminal") {
  const db = openDatabase(":memory:");
  cleanups.push(() => db.close());
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4), gateRuleMigration(5)]);
  const gates = new SqliteGateStore(db, { migrate: false });
  const runtime = new WorkflowRuntime({ db, gates, runner: inlineRunner(() => "unused"), gatePollMs: 5, authority: { actor: { class: actor, id: `${actor}-1` } } });
  cleanups.push(() => runtime.shutdown());
  return { runtime, gates };
}

async function answerWhenPending(h: ReturnType<typeof host>, runId: string, stepId: string, payload: Record<string, unknown>): Promise<void> {
  await vi.waitFor(() => expect(h.gates.listPending()).toHaveLength(1));
  h.runtime.signal(runId, stepId, payload, OWNER);
  await vi.waitFor(() => expect(h.gates.listPending()).toHaveLength(0));
}

function gates(records: TraceRecord[]): TraceGate[] {
  return records.filter((record): record is TraceGate => record.kind === "gate");
}

function storedGate(id: string): GateRecord {
  return {
    id, prompt: RAW.prompt, schema: undefined, status: "resolved", payload: { signal: "allow" }, reason: undefined, createdAt: "2026-10-12T00:00:05.000Z",
    resolvedAt: "2026-10-12T00:00:06.000Z", expiresAt: undefined, resolvedBy: { class: "worker", id: "reviewer-2", channel: "chat" }, resolvedEvidence: undefined,
    rule: undefined, summary: undefined, evidenceRef: undefined, questions: undefined,
  };
}

function storedRun(stepResults: Record<string, StepResult>): WorkflowRun {
  return {
    id: "run-1", workflowName: "work", params: {}, status: "completed", currentStep: null, stepResults, activeSteps: {},
    revision: 1, ownerGeneration: 1, startedAt: "2026-10-12T00:00:00.000Z", completedAt: "2026-10-12T00:01:00.000Z", error: null,
  };
}

function storeOf(...records: GateRecord[]): RunTraceSources["gates"] {
  return { get: (id) => records.find((record) => record.id === id) };
}

function dispatchWith(data: Record<string, unknown>): StepResult {
  return { stepId: "land", iteration: 0, operation: "dispatch", agentId: "agent-1", signal: null, completedAt: "2026-10-12T00:00:10.000Z", data };
}

describe("projectRunTrace human gates", () => {
  it("names an assisted step's iteration-1 gate as assistedGateId does", async () => {
    const h = host();
    const twice: WorkflowFn = async (ctx) => { await ctx.assisted("approve", RAW.prompt); await ctx.assisted("approve", RAW.prompt); };
    h.runtime.register("flow", twice);
    const runId = h.runtime.start("flow");
    await answerWhenPending(h, runId, "approve", { signal: "revise", note: RAW.answer });
    await answerWhenPending(h, runId, "approve", { signal: "allow" });
    const run = await h.runtime.wait(runId);

    const [first, second] = gates(projectRunTrace(run, { gates: h.gates, digest }));

    expect(first).toMatchObject({ id: `${runId}/approve`, attemptId: `workflow:${runId}:approve:0:0`, status: "resolved", decidedBy: "human:owner" });
    expect(second).toMatchObject({ id: `${runId}/approve:1`, attemptId: `workflow:${runId}:approve:1:0`, promptSha256: digest(RAW.prompt) });
    expect(second!.id).toBe(assistedGateId(run, "approve", 1, () => false));
    expect(second).not.toHaveProperty("verdict");
  });

  it("still finds a 0.2.x gate left on the bare id at iteration 1", () => {
    const run = storedRun({
      "review:0": { stepId: "review", iteration: 0, operation: "dispatch", agentId: "agent-1", signal: null, completedAt: "2026-10-12T00:00:04.000Z" },
      "review:1": { stepId: "review", iteration: 1, operation: "assisted", agentId: null, signal: "allow", completedAt: "2026-10-12T00:00:06.000Z", data: { signal: "allow" } },
    });

    const [gate] = gates(projectRunTrace(run, { gates: storeOf(storedGate("run-1/review")), digest }));

    expect(gate).toMatchObject({ id: "run-1/review", attemptId: "workflow:run-1:review:1:0", gateKind: "human", decidedBy: "agent:reviewer-2" });
  });

  it("projects the policy decision and the owner's gate for an owner-approved authorize step", async () => {
    const h = host("automation");
    h.runtime.register("flow", async (ctx) => void (await ctx.authorize("merge", { action: "merge", subject: SUBJECT })));
    const runId = h.runtime.start("flow");
    await answerWhenPending(h, runId, "merge", { decision: "approve", subject: SUBJECT });
    const run = await h.runtime.wait(runId);

    const [policy, human] = gates(projectRunTrace(run, { gates: h.gates, digest }));

    expect(policy).toMatchObject({ gateKind: "policy", decidedBy: "policy:F5", policyRule: { table: "F5", rowId: "MRG-AU" } });
    expect(human).toMatchObject({ id: `${runId}/merge`, gateKind: "human", status: "resolved", decidedBy: "human:owner", payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("projects the gate a paused run waits on, digesting its prompt", async () => {
    const h = host();
    h.runtime.register("flow", async (ctx) => void (await ctx.assisted("approve", RAW.prompt)));
    const runId = h.runtime.start("flow");
    await vi.waitFor(() => expect(h.runtime.status(runId)?.status).toBe("paused"));

    const records = projectRunTrace(h.runtime.status(runId)!, { gates: h.gates, digest });

    expect(gates(records)).toEqual([expect.objectContaining({ id: `${runId}/approve`, status: "pending", promptSha256: digest(RAW.prompt) })]);
    h.runtime.cancel(runId, "test over");
  });

  it("emit records that pass the strict schema and carry no gate prompt or answer text", async () => {
    const h = host();
    h.runtime.register("flow", async (ctx) => void (await ctx.assisted("approve", RAW.prompt)));
    const runId = h.runtime.start("flow");
    await answerWhenPending(h, runId, "approve", { signal: "allow", note: RAW.answer });

    const records = projectRunTrace(await h.runtime.wait(runId), { gates: h.gates, digest });

    for (const record of records) expect(TraceRecordSchema.parse(record)).toEqual(record);
    expect(JSON.stringify(records)).not.toMatch(new RegExp(`${RAW.prompt}|${RAW.answer}`));
  });
});

describe("projectRunTrace artifacts", () => {
  it("copies a valid pr artifact from a dispatch's data unchanged", () => {
    const run = storedRun({ "land:0": dispatchWith({ [TRACE_ARTIFACTS_KEY]: [PR_ARTIFACT] }) });

    const records = projectRunTrace(run, { gates: storeOf(), digest });

    expect(records.filter((record) => record.kind === "artifact")).toEqual([PR_ARTIFACT]);
  });

  it("throws naming the step when a titan.trace.artifacts entry is malformed", () => {
    const run = storedRun({ "land:0": dispatchWith({ [TRACE_ARTIFACTS_KEY]: [{ ...PR_ARTIFACT, number: 0 }] }) });

    expect(() => projectRunTrace(run, { gates: storeOf(), digest })).toThrow(/step land \(land:0\): titan\.trace\.artifacts\[0\]/);
  });

  it("throws when titan.trace.gates is not an array", () => {
    const run = storedRun({ "land:0": dispatchWith({ "titan.trace.gates": { kind: "gate" } }) });

    expect(() => projectRunTrace(run, { gates: storeOf(), digest })).toThrow(/step land \(land:0\): titan\.trace\.gates is not an array/);
  });
});
