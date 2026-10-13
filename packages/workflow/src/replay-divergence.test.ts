import { randomUUID } from "node:crypto";
import type { GateResolver } from "@titan-design/hitl";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { WorkflowRuntime } from "./runtime.js";
import { WorkflowRunStore, newRun, workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { RecoverableStepRunner, StepRunner, WorkflowEvent, WorkflowFn } from "./types.js";

const OWNER: GateResolver = { class: "owner-terminal", id: "owner", channel: "test" };
const HANGS = "ci-wait";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

function runtime(db: Db, runner: StepRunner, events: WorkflowEvent[] = []): WorkflowRuntime {
  const gates = new SqliteGateStore(db, { migrate: false });
  return new WorkflowRuntime({ db, gates, runner, onEvent: (e) => events.push(e), gatePollMs: 10 });
}

/** The build-N runner: every step finishes at once except `ci-wait`, which is still running at the deploy. */
const firstBuildRunner: RecoverableStepRunner = {
  dispatch: async (input) => ({
    executionId: input.executionId,
    requestKey: input.requestKey,
    runnerRef: `ref-${input.stepId}`,
    completion: input.stepId === HANGS ? new Promise(() => undefined) : Promise.resolve({ kind: "succeeded", output: `${input.stepId} done` }),
  }),
  reconcile: async () => ({ kind: "unknown", evidence: "not used before the deploy" }),
};

/** The build-N+1 runner: `ci-wait` finished while the host was down; any dispatch is a live call the test counts. */
function nextBuildRunner(): { runner: RecoverableStepRunner; dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn(firstBuildRunner.dispatch);
  return {
    dispatch,
    runner: { dispatch, reconcile: async () => ({ kind: "terminal", outcome: { kind: "succeeded", output: "ci green" }, evidence: "ledger terminal" }) },
  };
}

const definitionN: WorkflowFn = async (ctx) => {
  await ctx.dispatch("conflict-check", "check");
  await ctx.dispatch("publish-review", "publish");
  await ctx.dispatch(HANGS, "wait");
};

const insertsGate: WorkflowFn = async (ctx) => {
  await ctx.dispatch("conflict-check", "check");
  await ctx.assisted("approve-merge", "Merge?");
  await ctx.dispatch("publish-review", "publish");
  await ctx.dispatch(HANGS, "wait");
};

const insertsDispatch: WorkflowFn = async (ctx) => {
  await ctx.dispatch("conflict-check", "check");
  await ctx.dispatch("sh-extra", "extra");
  await ctx.dispatch("publish-review", "publish");
  await ctx.dispatch(HANGS, "wait");
};

const catchesRefusal: WorkflowFn = async (ctx) => {
  await ctx.dispatch("conflict-check", "check");
  await ctx.assisted("approve-merge", "Merge?").catch(() => undefined);
  await ctx.dispatch("sh-extra", "extra");
};

async function recordUnderFirstBuild(db: Db, definition: WorkflowFn, answer?: (rt: WorkflowRuntime, runId: string) => Promise<void>): Promise<string> {
  const first = runtime(db, firstBuildRunner);
  first.register("shepherd", definition);
  const runId = first.start("shepherd");
  await answer?.(first, runId);
  await vi.waitFor(() => expect(first.status(runId)?.activeSteps[HANGS]).toBeDefined());
  first.shutdown();
  return runId;
}

async function replayUnderNextBuild(db: Db, runId: string, definition: WorkflowFn, strictReplay = true) {
  const events: WorkflowEvent[] = [];
  const { runner, dispatch } = nextBuildRunner();
  const next = runtime(db, runner, events);
  next.register("shepherd", definition, { strictReplay });
  await next.hydrate();
  return { next, events, dispatch, run: () => next.wait(runId) };
}

function gatesOpened(events: WorkflowEvent[]): string[] {
  return events.flatMap((e) => (e.type === "gate_opened" ? [e.gateId] : []));
}

describe("strict replay across a deploy", () => {
  it("parks a replay that inserts an approve-merge gate before a recorded step, before opening it", async () => {
    const db = makeDb();
    const runId = await recordUnderFirstBuild(db, definitionN);

    const { events, dispatch, run } = await replayUnderNextBuild(db, runId, insertsGate);
    const replayed = await run();

    expect(replayed.status).toBe("recovery_required");
    expect(replayed.error).toBe('replay diverged: assisted("approve-merge") ran live with 1 recorded results unread, next publish-review:0');
    expect(gatesOpened(events)).toEqual([]);
    expect(Object.keys(replayed.stepResults)).not.toContain("approve-merge");
    expect(dispatch).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "workflow_recovery_required", stepId: "approve-merge" }));
  });

  it("parks a replay that inserts a dispatch before a recorded step, before the runner sees it", async () => {
    const db = makeDb();
    const runId = await recordUnderFirstBuild(db, definitionN);

    const { dispatch, run } = await replayUnderNextBuild(db, runId, insertsDispatch);
    const replayed = await run();

    expect(replayed.status).toBe("recovery_required");
    expect(replayed.error).toMatch(/^replay diverged: dispatch\("sh-extra"\) ran live .* next publish-review:0$/);
    expect(dispatch).not.toHaveBeenCalled();
    expect(replayed.activeSteps["sh-extra"]).toBeUndefined();
  });

  it("keeps refusing after workflow code catches the refusal and makes another live call", async () => {
    const db = makeDb();
    const runId = await recordUnderFirstBuild(db, definitionN);

    const { events, dispatch, run } = await replayUnderNextBuild(db, runId, catchesRefusal);
    const replayed = await run();

    expect(replayed.status).toBe("recovery_required");
    expect(replayed.error).toMatch(/^replay diverged: assisted\("approve-merge"\)/);
    expect(dispatch).not.toHaveBeenCalled();
    expect(gatesOpened(events)).toEqual([]);
  });

  it("opens the inserted gate as before when the workflow did not opt in", async () => {
    const db = makeDb();
    const runId = await recordUnderFirstBuild(db, definitionN);

    const { next, events } = await replayUnderNextBuild(db, runId, insertsGate, false);
    await vi.waitFor(() => expect(gatesOpened(events)).toEqual([`${runId}/approve-merge`]));
    next.shutdown();
  });

  it("completes a faithful replay that re-claims the step running at the deploy", async () => {
    const db = makeDb();
    const gateThenSteps: WorkflowFn = async (ctx) => {
      await ctx.assisted("land", "Land?");
      await ctx.dispatch("land", "check");
      await ctx.dispatch(HANGS, "wait");
    };
    const answer = async (rt: WorkflowRuntime, runId: string): Promise<void> => {
      await vi.waitFor(() => expect(rt.status(runId)?.status).toBe("paused"));
      rt.signal(runId, "land", { signal: "approved" }, OWNER);
    };
    const runId = await recordUnderFirstBuild(db, gateThenSteps, answer);

    const { dispatch, run } = await replayUnderNextBuild(db, runId, gateThenSteps);
    const replayed = await run();

    expect(replayed.status).toBe("completed");
    expect(replayed.stepResults[`${HANGS}:0`]).toMatchObject({ output: "ci green" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("completes a replay whose other branch reads its records on later turns", async () => {
    const db = makeDb();
    const concurrent: WorkflowFn = async (ctx) => {
      const reviews = async (): Promise<void> => {
        for (const step of ["a", "b", "c"]) {
          await new Promise(setImmediate);
          await ctx.dispatch(step, step);
        }
      };
      await Promise.all([reviews(), ctx.dispatch(HANGS, "wait")]);
    };
    const first = runtime(db, firstBuildRunner);
    first.register("shepherd", concurrent);
    const runId = first.start("shepherd");
    await vi.waitFor(() => expect(Object.keys(first.status(runId)?.stepResults ?? {})).toHaveLength(3));
    first.shutdown();

    const { dispatch, run } = await replayUnderNextBuild(db, runId, concurrent);
    const replayed = await run();

    expect(replayed.status).toBe("completed");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("replays a 0.4 row as before, unread results included, since its keys carry no operation", async () => {
    const db = makeDb();
    const gates = new SqliteGateStore(db, { migrate: false });
    const legacy = newRun(randomUUID(), "shepherd", {});
    legacy.status = "paused";
    legacy.currentStep = "ship";
    legacy.stepResults = {
      x: { stepId: "x", iteration: 0, agentId: null, signal: null, completedAt: "2026-09-20T00:00:00.000Z", data: { topic: "original" } },
      "review:0": { stepId: "review", iteration: 0, agentId: null, signal: null, completedAt: "2026-09-20T00:00:01.000Z", output: "dropped since" },
    };
    new WorkflowRunStore(db).create(legacy);
    gates.create({ id: `${legacy.id}/ship`, prompt: "Ship?" });
    const legacyShape: WorkflowFn = async (ctx) => {
      await ctx.seed("x", async () => ({ data: { topic: "reseeded" } }));
      await ctx.assisted("ship", "Ship?");
    };

    const { next, run } = await replayUnderNextBuild(db, legacy.id, legacyShape);
    next.signal(legacy.id, "ship", { signal: "shipped" }, OWNER);
    const replayed = await run();

    expect(replayed.status).toBe("completed");
    expect(replayed.stepResults.ship).toMatchObject({ signal: "shipped" });
  });
});
