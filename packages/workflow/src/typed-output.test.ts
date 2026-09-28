import { randomUUID } from "node:crypto";
import type { GateResolver } from "@titan-design/hitl";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mapItems, type MapResult } from "./fan-out.js";
import { idempotentRunner, inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import type { WorkflowRuntimeOptions } from "./runtime-options.js";
import { WorkflowRunStore, newRun, workflowMigration, workflowOwnershipMigration } from "./store.js";
import {
  StepFailedError,
  StepOutputInvalidError,
  type StepResult,
  type StepRunInput,
  type StepRunner,
  type WorkflowEvent,
  type WorkflowFn,
} from "./types.js";

const OWNER: GateResolver = { class: "owner-terminal", id: "owner", channel: "test" };

const verdictSchema = z.object({ verdict: z.enum(["approved", "needs_changes"]) });

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

function runtime(db: Db, runner: StepRunner, extra: Partial<WorkflowRuntimeOptions> = {}): WorkflowRuntime {
  return new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, gatePollMs: 10, ...extra });
}

function replies(...outputs: string[]): ReturnType<typeof vi.fn<(input: StepRunInput) => string>> {
  const fn = vi.fn<(input: StepRunInput) => string>();
  for (const output of outputs) fn.mockReturnValueOnce(output);
  return fn;
}

/** Runs one schema dispatch, catching its failure so the test can inspect it. */
function catchingReview(sink: unknown[], schema: z.ZodType<Record<string, unknown>> = verdictSchema): WorkflowFn {
  return async (ctx) => {
    try {
      await ctx.dispatch("review", "Review the change", { schema });
    } catch (error) {
      sink.push(error);
    }
  };
}

function storedRun(db: Db, workflowName: string, review: Partial<StepResult>): string {
  const run = newRun(randomUUID(), workflowName, {});
  run.status = "paused";
  run.currentStep = "ship";
  run.stepResults = {
    "review:0": { stepId: "review", iteration: 0, agentId: null, signal: null, completedAt: "2026-09-20T00:00:00.000Z", output: '{"verdict":"approved"}', ...review },
  };
  new WorkflowRunStore(db).create(run);
  return run.id;
}

const reviewOnly: WorkflowFn = async (ctx) => {
  await ctx.dispatch("review", "Review", { schema: verdictSchema });
};

const reviewThenShip: WorkflowFn = async (ctx) => {
  const review = await ctx.dispatch("review", "Review", { schema: verdictSchema });
  if (review.data?.verdict === "approved") await ctx.assisted("ship", "Ship?");
  else await ctx.dispatch("fix", "Fix");
};

describe("typed dispatch output", () => {
  it("a review step returns a verdict and the workflow branches on it", async () => {
    const runner = replies('{"verdict":"needs_changes"}', "fixed", '{"verdict":"approved"}');
    const rt = runtime(makeDb(), inlineRunner(runner));
    rt.register("review-loop", async (ctx) => {
      let review = await ctx.dispatch("review", "Review", { schema: verdictSchema });
      while (review.data?.verdict !== "approved") {
        if (ctx.iteration("review") > 2) throw new Error("review never approved");
        await ctx.dispatch("fix", "Fix");
        review = await ctx.dispatch("review", "Review", { schema: verdictSchema });
      }
    });

    const run = await rt.wait(rt.start("review-loop"));

    expect(run.status).toBe("completed");
    expect(run.stepResults["review:1"]?.data).toEqual({ verdict: "approved" });
    expect(Object.keys(run.stepResults).sort()).toEqual(["fix:0", "review:0", "review:1"]);
  });

  it("an invalid payload fails the step without a retry loop", async () => {
    const run = vi.fn(async () => ({ ok: true as const, output: '{"verdict":3}', usage: { costUsd: 0.2 } }));
    const events: WorkflowEvent[] = [];
    const rt = runtime(makeDb(), { run }, { onEvent: (event) => events.push(event) });
    const errors: unknown[] = [];
    rt.register("review", catchingReview(errors));

    const finished = await rt.wait(rt.start("review"));

    const error = errors[0] as StepOutputInvalidError;
    expect(run).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "step_retry")).toEqual([]);
    expect(error).toBeInstanceOf(StepOutputInvalidError);
    expect(error).toBeInstanceOf(StepFailedError);
    expect(error).toMatchObject({ kind: "schema", retryable: false, usage: { costUsd: 0.2 } });
    expect(error.issues.join()).toMatch(/verdict/);
    expect(finished.stepResults["review:0"]).toBeUndefined();
    expect(finished.activeSteps).toEqual({});
  });

  it("prose output fails the step as not_json rather than a raw SyntaxError", async () => {
    const errors: unknown[] = [];
    const rt = runtime(makeDb(), inlineRunner(() => "Looks good to me."));
    rt.register("review", catchingReview(errors));

    await rt.wait(rt.start("review"));

    expect(errors[0]).toBeInstanceOf(StepOutputInvalidError);
    expect(errors[0]).toMatchObject({ kind: "not_json", retryable: false });
  });

  it("a payload over the data bound fails the step as too_large", async () => {
    const errors: unknown[] = [];
    const notes = "n".repeat(2048);
    const rt = runtime(makeDb(), inlineRunner(() => JSON.stringify({ verdict: "approved", notes })), { maxStepDataBytes: 1024 });
    rt.register("review", catchingReview(errors, verdictSchema.extend({ notes: z.string() })));

    await rt.wait(rt.start("review"));

    expect(errors[0]).toMatchObject({ kind: "too_large", retryable: false });
  });

  it("keeps titan.trace keys that the step schema does not declare", async () => {
    const payload = { verdict: "approved", "titan.trace.artifacts": [{ id: "a1" }], "titan.trace.gates": "declared-raw", other: 1 };
    const rt = runtime(makeDb(), inlineRunner(() => JSON.stringify(payload)));
    const schema = verdictSchema.extend({ "titan.trace.gates": z.string().transform((value) => value.toUpperCase()) });
    rt.register("review", async (ctx) => {
      await ctx.dispatch("review", "Review", { schema });
    });

    const run = await rt.wait(rt.start("review"));

    expect(run.stepResults["review:0"]?.data).toEqual({ verdict: "approved", "titan.trace.artifacts": [{ id: "a1" }], "titan.trace.gates": "DECLARED-RAW" });
  });

  it("counts carried trace keys toward the data bound", async () => {
    const errors: unknown[] = [];
    const payload = { verdict: "approved", "titan.trace.artifacts": "x".repeat(2048) };
    const rt = runtime(makeDb(), inlineRunner(() => JSON.stringify(payload)), { maxStepDataBytes: 1024 });
    rt.register("review", catchingReview(errors));

    await rt.wait(rt.start("review"));

    expect(errors[0]).toMatchObject({ kind: "too_large" });
  });

  it("a dispatch without a schema stores no data property", async () => {
    const rt = runtime(makeDb(), inlineRunner(() => '{"verdict":"approved"}'));
    rt.register("plain", async (ctx) => {
      await ctx.dispatch("review", "Review");
    });

    const run = await rt.wait(rt.start("plain"));

    expect(run.stepResults["review:0"]).not.toHaveProperty("data");
  });

  it("hands the step schema to the runner, and nothing without one", async () => {
    const runner = replies('{"verdict":"approved"}', "plain");
    const rt = runtime(makeDb(), inlineRunner(runner));
    rt.register("both", async (ctx) => {
      await ctx.dispatch("review", "Review", { schema: verdictSchema });
      await ctx.dispatch("note", "Note");
    });

    await rt.wait(rt.start("both"));

    expect(runner.mock.calls[0]?.[0].outputSchema).toBe(verdictSchema);
    expect(runner.mock.calls[1]?.[0].outputSchema).toBeUndefined();
  });

  it("parses a step re-dispatched after a crash with its schema", async () => {
    const db = makeDb();
    const first = runtime(db, idempotentRunner(inlineRunner(() => new Promise<string>(() => undefined))));
    first.register("review", reviewOnly);
    const runId = first.start("review");
    await vi.waitFor(() => expect(first.status(runId)?.activeSteps.review).toBeDefined());
    first.shutdown();
    const second = runtime(db, idempotentRunner(inlineRunner(() => '{"verdict":"needs_changes"}')));
    second.register("review", reviewOnly);

    await second.hydrate();
    const run = await second.wait(runId);

    expect(run.stepResults["review:0"]?.data).toEqual({ verdict: "needs_changes" });
  });

  it("records an item with an invalid payload as a non-retryable failure in mapItems", async () => {
    const sink: MapResult<string>[] = [];
    const rt = runtime(makeDb(), inlineRunner((input) => (input.prompt.endsWith("a") ? "not json" : '{"verdict":"approved"}')));
    rt.register("fan", async (ctx) => {
      sink.push(await mapItems(ctx, "judge", ["a", "b"], (item, stepId) => ctx.dispatch(stepId, `judge ${item}`, { schema: verdictSchema }), { key: (item) => item }));
    });

    const run = await rt.wait(rt.start("fan"));

    expect(run.status).toBe("completed");
    expect(sink[0]?.failed).toMatchObject([{ key: "a", retryable: false }]);
    expect(sink[0]).toMatchObject({ stoppedBy: "failure", skipped: [{ key: "b" }] });
  });
});

describe("replaying typed dispatch output", () => {
  it.each([
    { release: "0.4, with no operation", review: {} },
    { release: "0.5, with the dispatch operation", review: { operation: "dispatch" as const } },
  ])("a run stored by $release and without data replays with typed data", async ({ review }) => {
    const db = makeDb();
    const runId = storedRun(db, "gated", review);
    new SqliteGateStore(db, { migrate: false }).create({ id: `${runId}/ship`, prompt: "Ship?" });
    const runner = vi.fn(() => "unused");
    const rt = runtime(db, inlineRunner(runner));
    rt.register("gated", reviewThenShip);

    await rt.hydrate();
    rt.signal(runId, "ship", { signal: "shipped" }, OWNER);
    const run = await rt.wait(runId);

    expect(run.status).toBe("completed");
    expect(runner).not.toHaveBeenCalled();
    expect(run.stepResults.ship).toMatchObject({ signal: "shipped" });
    expect(run.stepResults["review:0"]).not.toHaveProperty("data");
  });

  it("fails the run when the recorded output no longer fits the step schema", async () => {
    const db = makeDb();
    const runId = storedRun(db, "drifted", { operation: "dispatch" });
    const runner = vi.fn(() => "unused");
    const rt = runtime(db, inlineRunner(runner));
    rt.register("drifted", async (ctx) => {
      await ctx.dispatch("review", "Review", { schema: verdictSchema.extend({ score: z.number() }) });
    });

    await rt.hydrate();
    const run = await rt.wait(runId);

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/dispatch\("review"\).*score/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns a recorded result with data unchanged to a dispatch without a schema", async () => {
    const db = makeDb();
    const runId = storedRun(db, "older", { operation: "dispatch", data: { verdict: "approved", extra: true } });
    const seen: StepResult[] = [];
    const rt = runtime(db, inlineRunner(() => "unused"));
    rt.register("older", async (ctx) => {
      seen.push(await ctx.dispatch("review", "Review"));
    });

    await rt.hydrate();
    await rt.wait(runId);

    expect(seen[0]?.data).toEqual({ verdict: "approved", extra: true });
  });

  it("replays a transforming schema to the transformed value", async () => {
    const db = makeDb();
    const runId = storedRun(db, "shouting", { operation: "dispatch" });
    const seen: unknown[] = [];
    const rt = runtime(db, inlineRunner(() => "unused"));
    rt.register("shouting", async (ctx) => {
      const schema = z.object({ verdict: z.string().transform((value) => value.toUpperCase()) });
      seen.push((await ctx.dispatch("review", "Review", { schema })).data?.verdict);
    });

    await rt.hydrate();
    await rt.wait(runId);

    expect(seen).toEqual(["APPROVED"]);
  });
});
