import { SqliteGateStore, gateMigration } from "@titan-design/hitl";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration } from "./store.js";
import type { StepRunInput, StepRunner, WorkflowEvent, WorkflowFn } from "./types.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2)]);
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

  it("re-attaches to in-flight steps on hydrate when the runner can", async () => {
    const db = makeDb();
    const first = runtime(db, { run: () => new Promise(() => undefined) });
    const wf: WorkflowFn = async (ctx) => {
      await ctx.dispatch("long", "long");
    };
    first.register("wf", wf);
    const runId = first.start("wf");
    await vi.waitFor(() => expect(first.status(runId)?.activeSteps.long).toBeDefined());
    first.shutdown();

    const attaching: StepRunner = {
      run: async () => ({ ok: true, output: "should not run" }),
      attach: async () => ({ ok: true, output: "finished while we were down\n<!-- signal: approved -->" }),
    };
    const second = runtime(db, attaching);
    second.register("wf", wf);
    await second.hydrate();
    const run = await second.wait(runId);
    expect(run.status).toBe("completed");
    expect(run.stepResults["long:0"]).toMatchObject({ output: expect.stringContaining("finished"), signal: "approved" });
  });
});
