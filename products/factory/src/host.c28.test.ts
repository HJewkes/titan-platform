import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowContext, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { defineWorkflow, type RegisteredSteps, type StepDeclaration } from "./definition.js";
import { openFactoryHost } from "./host.js";
import { unlessPast } from "./runner/not-after.js";
import { OWNER } from "./test-support/resolver.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-c28-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

const registry: RegisteredSteps = {
  entries: [
    { name: "prepare", op: "seed" },
    { name: "settle", op: "seed", fact: "landed" },
    { name: "publish", op: "seed" },
    { name: "approve", op: "assisted" },
  ],
};

let settleCalls = 0;
const outcomes: unknown[] = [];
const seedStep = (ctx: WorkflowContext, id: string, data: Record<string, string> = {}) => ctx.seed(id, async () => ({ data }));
const approve = (ctx: WorkflowContext) =>
  ctx.assisted("approve", "Approve?", { schema: z.object({ approve: z.literal(true) }), brief: { summary: "Approve?", evidenceRef: "$ git log -1" } });

/** P, X, then the gate: the recipe as an in-flight run recorded it. */
const original = defineWorkflow({
  name: "c28",
  steps: [{ id: "prepare", kind: "seed" }, { id: "publish", kind: "seed" }, { id: "approve", kind: "assisted" }],
  run: async (ctx) => {
    await seedStep(ctx, "prepare");
    await seedStep(ctx, "publish");
    await approve(ctx);
  },
});

/** P, then the gate: a recipe whose record ends before the point S is inserted at. */
const gatedEarly = defineWorkflow({
  name: "c28",
  steps: [{ id: "prepare", kind: "seed" }, { id: "approve", kind: "assisted" }],
  run: async (ctx) => {
    await seedStep(ctx, "prepare");
    await approve(ctx);
  },
});

const settle = (ctx: WorkflowContext) => ctx.seed("settle", async () => ({ data: { settled: String((settleCalls += 1)) } }));
const insertedSteps: StepDeclaration[] = [
  { id: "prepare", kind: "seed" },
  { id: "settle", kind: "seed", notAfter: "landed" },
  { id: "publish", kind: "seed" },
  { id: "approve", kind: "assisted" },
];

/** S inserted between P and X; the gate stays last. */
const inserted = defineWorkflow({
  name: "c28",
  steps: insertedSteps,
  run: async (ctx) => {
    await seedStep(ctx, "prepare");
    const outcome = await unlessPast(ctx, "settle", () => settle(ctx));
    outcomes.push(outcome.skipped ? "skipped" : outcome.value.data);
    if (!ctx.param("early")) await seedStep(ctx, "publish");
    await approve(ctx);
  },
});

async function pausedUnder(dbPath: string, definition: typeof original, params: Record<string, string> = {}): Promise<string> {
  const host = openFactoryHost({ dbPath, workflows: [definition], registry, routes: [], gatePollMs: 10 });
  const runId = host.runtime.start("c28", params);
  await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("paused"));
  host.close();
  return runId;
}

async function answeredUnder(dbPath: string, runId: string, definition: typeof original): Promise<WorkflowRun> {
  const host = openFactoryHost({ dbPath, workflows: [definition], registry, routes: [], gatePollMs: 10 });
  try {
    await host.adopt();
    if (host.runtime.status(runId)?.status === "paused") host.runtime.signal(runId, "approve", { approve: true }, OWNER);
    return await vi.waitFor(() => {
      const run = host.runtime.status(runId);
      if (!run || !["completed", "recovery_required", "failed"].includes(run.status)) throw new Error(`run ${runId} has not settled`);
      return run;
    });
  } finally {
    host.close();
  }
}

afterEach(() => {
  settleCalls = 0;
  outcomes.splice(0);
});

describe("C28: a step inserted before a live call site", () => {
  it("A17: an in-flight run past an inserted step finishes", async () => {
    const dbPath = dbFile();
    const runId = await pausedUnder(dbPath, original);

    const run = await answeredUnder(dbPath, runId, inserted);

    expect(run.status).toBe("completed");
    expect(Object.keys(run.stepResults).some((key) => key.includes("settle"))).toBe(false);
    expect(settleCalls).toBe(0);
    expect(outcomes).toEqual(["skipped"]);
  });

  it("a run started after the insertion runs the inserted step", async () => {
    const dbPath = dbFile();
    const runId = await pausedUnder(dbPath, inserted);

    const run = await answeredUnder(dbPath, runId, inserted);

    expect(run.status).toBe("completed");
    expect(Object.keys(run.stepResults).filter((key) => key.includes("settle"))).toHaveLength(1);
    expect(settleCalls).toBe(1);
  });

  it("a run whose record ends before the inserted step runs it live on resume", async () => {
    const dbPath = dbFile();
    const runId = await pausedUnder(dbPath, gatedEarly, { early: "1" });

    const run = await answeredUnder(dbPath, runId, inserted);

    expect(run.status).toBe("completed");
    expect(settleCalls).toBe(1);
    expect(outcomes).toEqual([{ settled: "1" }]);
  });

  it("a run that recorded the inserted step replays it from the record", async () => {
    const dbPath = dbFile();
    const runId = await pausedUnder(dbPath, inserted);
    outcomes.splice(0);

    const run = await answeredUnder(dbPath, runId, inserted);

    expect(run.status).toBe("completed");
    expect(settleCalls).toBe(1);
    expect(outcomes).toEqual([{ settled: "1" }]);
  });
});
