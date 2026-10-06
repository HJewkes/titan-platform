import type { GateBrief, GateStore } from "@titan-design/hitl";
import { SqliteGateStore, gateBriefMigration, gateMigration, gateResolverMigration, gateRuleMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { WorkflowEvent, WorkflowFn } from "./types.js";

const BRIEF: GateBrief = {
  summary: "Ship the widgets draft? Review passed. Recommend ship.",
  evidenceRef: "https://example.com/widgets/pull/7",
  questions: [{ id: "decision", question: "Ship it?", options: [{ id: "ship", label: "Ship", recommended: true }, { id: "hold", label: "Hold" }] }],
};
const CHANGED_BRIEF: GateBrief = { summary: "Hold the widgets draft? Recommend hold.", evidenceRef: "$ widgets status" };

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4), gateRuleMigration(5), gateBriefMigration(6)]);
  return db;
}

function runtime(db: Db, events: WorkflowEvent[] = []): { rt: WorkflowRuntime; gates: GateStore } {
  const gates = new SqliteGateStore(db, { migrate: false });
  const rt = new WorkflowRuntime({ db, gates, runner: inlineRunner(() => "unused"), onEvent: (e) => events.push(e), gatePollMs: 5 });
  return { rt, gates };
}

function briefed(brief: GateBrief): WorkflowFn {
  return async (ctx) => void (await ctx.assisted("approve", "Approve the draft?", { brief }));
}

async function pausedRun(rt: WorkflowRuntime, flow: WorkflowFn): Promise<string> {
  rt.register("gated", flow);
  const runId = rt.start("gated");
  await vi.waitFor(() => expect(rt.status(runId)?.status).toBe("paused"));
  return runId;
}

describe("ctx.assisted brief", () => {
  it("an assisted step's brief lands on the gate row", async () => {
    const { rt, gates } = runtime(makeDb());

    const runId = await pausedRun(rt, briefed(BRIEF));

    expect(gates.get(`${runId}/approve`)).toMatchObject({ prompt: "Approve the draft?", ...BRIEF });
    rt.shutdown();
  });

  it("a brief carrying extra id and schema keys leaves the gate's id and schema unchanged", async () => {
    const { rt, gates } = runtime(makeDb());
    const rogue = { ...BRIEF, id: "other", schema: { type: "number" } };

    const runId = await pausedRun(rt, briefed(rogue));

    expect(gates.get("other")).toBeUndefined();
    expect(gates.get(`${runId}/approve`)).toMatchObject({ prompt: "Approve the draft?", ...BRIEF });
    expect(gates.get(`${runId}/approve`)?.schema).not.toEqual({ type: "number" });
    rt.shutdown();
  });

  it("gate_opened carries the summary", async () => {
    const events: WorkflowEvent[] = [];
    const { rt } = runtime(makeDb(), events);

    const runId = await pausedRun(rt, briefed(BRIEF));

    expect(events.find((e) => e.type === "gate_opened")).toEqual({
      type: "gate_opened",
      runId,
      stepId: "approve",
      gateId: `${runId}/approve`,
      prompt: "Approve the draft?",
      summary: BRIEF.summary,
    });
    rt.shutdown();
  });

  it("a resumed run does not reopen a gate even when the brief changed", async () => {
    const db = makeDb();
    const first = runtime(db);
    const runId = await pausedRun(first.rt, briefed(BRIEF));
    first.rt.shutdown();
    const events: WorkflowEvent[] = [];
    const second = runtime(db, events);
    second.rt.register("gated", briefed(CHANGED_BRIEF));

    expect(await second.rt.hydrate()).toEqual([runId]);
    await vi.waitFor(() => expect(second.rt.status(runId)?.status).toBe("paused"));

    expect(second.gates.get(`${runId}/approve`)).toMatchObject({ ...BRIEF, status: "pending" });
    expect(events.filter((e) => e.type === "gate_opened")).toEqual([]);
    second.rt.shutdown();
  });
});
