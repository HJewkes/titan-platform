import { randomUUID } from "node:crypto";
import { SqliteGateStore, gateMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import { WorkflowRunStore, newRun, workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { StepRunner, WorkflowEvent, WorkflowFn } from "./types.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3)]);
  return db;
}

function runtime(db: Db, runner: StepRunner, events: WorkflowEvent[] = []): WorkflowRuntime {
  const gates = new SqliteGateStore(db, { migrate: false });
  return new WorkflowRuntime({ db, gates, runner, onEvent: (e) => events.push(e), gatePollMs: 10 });
}

function gatesOpened(events: WorkflowEvent[]): string[] {
  return events.flatMap((e) => (e.type === "gate_opened" ? [e.gateId] : []));
}

const seedThenGate: WorkflowFn = async (ctx) => {
  await ctx.seed("x", async () => ({ data: { topic: "memo" } }));
  await ctx.assisted("x", "Approve {{topic}}?");
};

const draftThenGate: WorkflowFn = async (ctx) => {
  await ctx.dispatch("x", "draft");
  await ctx.assisted("x", "Approve?");
};

const gateThenDraft: WorkflowFn = async (ctx) => {
  await ctx.assisted("x", "Approve?");
  await ctx.dispatch("x", "draft");
};

const legacyShape: WorkflowFn = async (ctx) => {
  await ctx.seed("x", async () => ({ data: { topic: "reseeded" } }));
  await ctx.dispatch("x", "draft {{topic}}");
  await ctx.assisted("ship", "Ship?");
};

describe("memoized call keys", () => {
  it("opens a gate when assisted follows a seed on the same step id", async () => {
    const db = makeDb();
    const events: WorkflowEvent[] = [];
    const rt = runtime(db, inlineRunner(() => "unused"), events);
    rt.register("seeded", seedThenGate);
    const runId = rt.start("seeded");
    await vi.waitFor(() => expect(gatesOpened(events)).toHaveLength(1));
    rt.signal(runId, "x", { signal: "approved" });
    const run = await rt.wait(runId);

    expect(run.status).toBe("completed");
    expect(gatesOpened(events)).toEqual([`${runId}/x:1`]);
    expect(run.stepResults.x).toMatchObject({ operation: "seed", data: { topic: "memo" } });
    expect(run.stepResults["x:1"]).toMatchObject({ operation: "assisted", iteration: 1, signal: "approved" });
  });

  it("fails a run whose workflow was reordered while it was paused, without reusing the stale answer", async () => {
    const db = makeDb();
    const runner = vi.fn(() => "drafted");
    const first = runtime(db, inlineRunner(runner));
    first.register("review", draftThenGate);
    const runId = first.start("review");
    await vi.waitFor(() => expect(first.status(runId)?.status).toBe("paused"));
    first.shutdown();

    const events: WorkflowEvent[] = [];
    const second = runtime(db, inlineRunner(runner), events);
    second.register("review", gateThenDraft);
    await second.hydrate();
    const run = await second.wait(runId);

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/replayed assisted\("x"\) at call 0, where the run recorded dispatch/);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(gatesOpened(events)).toEqual([]);
  });

  it("resumes a run row stored by 0.4 on its recorded results and pending gate", async () => {
    const db = makeDb();
    const gates = new SqliteGateStore(db, { migrate: false });
    const legacy = newRun(randomUUID(), "legacy", {});
    legacy.status = "paused";
    legacy.currentStep = "ship";
    legacy.params = { topic: "original" };
    legacy.stepResults = {
      x: { stepId: "x", iteration: 0, agentId: null, signal: null, completedAt: "2026-09-20T00:00:00.000Z", data: { topic: "original" } },
      "x:0": { stepId: "x", iteration: 0, agentId: null, signal: null, completedAt: "2026-09-20T00:00:01.000Z", output: "draft original" },
    };
    new WorkflowRunStore(db).create(legacy);
    gates.create({ id: `${legacy.id}/ship`, prompt: "Ship?" });

    const runner = vi.fn(() => "redrafted");
    const events: WorkflowEvent[] = [];
    const rt = runtime(db, inlineRunner(runner), events);
    rt.register("legacy", legacyShape);
    expect(await rt.hydrate()).toEqual([legacy.id]);
    rt.signal(legacy.id, "ship", { signal: "shipped" });
    const run = await rt.wait(legacy.id);

    expect(run.status).toBe("completed");
    expect(runner).not.toHaveBeenCalled();
    expect(gatesOpened(events)).toEqual([]);
    expect(run.params.topic).toBe("original");
    expect(run.stepResults.ship).toMatchObject({ signal: "shipped" });
  });
});
