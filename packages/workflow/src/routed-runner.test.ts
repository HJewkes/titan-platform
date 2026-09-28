import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { routedRunner, type RestartRule, type RouteRunner, type RoutedStepInput, type StepRoute } from "./routed-runner.js";
import { inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { StepRunner, WorkflowFn } from "./types.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

function runtime(db: Db, runner: StepRunner): WorkflowRuntime {
  return new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, gatePollMs: 10 });
}

function countingRoute(match: string, onRestart: RestartRule, calls: string[]): StepRoute {
  return { match, onRestart, runner: inlineRunner((input) => (calls.push(input.stepId), `${match} done`)) };
}

const hanging: RouteRunner = { run: () => new Promise(() => undefined) };

const pilot: WorkflowFn = async (ctx) => {
  await ctx.seed("load", async () => ({ data: { task: "t1" } }));
  await ctx.dispatch("draft", "draft {{task}}", { model: "sonnet" });
  await ctx.dispatch("branch", "branch for {{task}}");
};

const oneStep: WorkflowFn = async (ctx) => {
  await ctx.dispatch(ctx.param("step") ?? "missing", "work");
};

describe("routedRunner", () => {
  it("sends model steps and code steps of one workflow to their own runners", async () => {
    const model = vi.fn(async (_input: RoutedStepInput) => ({ ok: true as const, output: "drafted", runnerRef: "session-1", usage: { costUsd: 0.2 } }));
    const code: string[] = [];
    const rt = runtime(makeDb(), routedRunner([{ match: "draft", onRestart: "repeat", runner: { run: model } }, countingRoute("branch", "park", code)]));
    rt.register("pilot", pilot);

    const run = await rt.wait(rt.start("pilot"));

    expect(run.status).toBe("completed");
    expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0]?.[0]).toMatchObject({ stepId: "draft", prompt: "draft t1", model: "sonnet", attempt: 0 });
    expect(code).toEqual(["branch"]);
    expect(run.stepResults["draft:0"]).toMatchObject({ output: "drafted", usage: { costUsd: 0.2 } });
    expect(run.stepResults["branch:0"]?.output).toBe("branch done");
  });

  it("matches a step family by id segment and prefers the longest route", () => {
    const runner = routedRunner([countingRoute("ci-wait", "repeat", []), countingRoute("ci-wait:final", "park", [])]);

    expect(runner.routeFor("ci-wait:2")?.match).toBe("ci-wait");
    expect(runner.routeFor("ci-wait:final")?.onRestart).toBe("park");
    expect(runner.routeFor("ci-waiting")).toBeUndefined();
  });

  it("refuses to register a workflow with a step id no route covers, naming every one", () => {
    const runner = routedRunner([countingRoute("draft", "repeat", [])]);

    expect(() => runner.assertRoutes("pilot", ["draft", "branch", "actuate"])).toThrow("workflow pilot: no route for branch, actuate");
    expect(() => runner.assertRoutes("pilot", ["draft"])).not.toThrow();
  });

  it("refuses two routes for the same step id", () => {
    expect(() => routedRunner([countingRoute("draft", "repeat", []), countingRoute("draft", "park", [])])).toThrow(/two routes match step id "draft"/);
  });

  it("redispatches a repeat step and parks a park step when a crash interrupts both", async () => {
    const db = makeDb();
    const first = runtime(db, routedRunner([{ match: "draft", onRestart: "repeat", runner: hanging }, { match: "actuate", onRestart: "park", runner: hanging }]));
    first.register("one", oneStep);
    const repeated = first.start("one", { step: "draft" });
    const parked = first.start("one", { step: "actuate" });
    await vi.waitFor(() => expect([repeated, parked].map((id) => Object.keys(first.status(id)?.activeSteps ?? {}))).toEqual([["draft"], ["actuate"]]));
    first.shutdown();

    const calls: string[] = [];
    const second = runtime(db, routedRunner([countingRoute("draft", "repeat", calls), countingRoute("actuate", "park", calls)]));
    second.register("one", oneStep);

    expect(await second.hydrate()).toEqual([repeated]);
    expect(await second.wait(repeated)).toMatchObject({ status: "completed", stepResults: { "draft:0": { output: "draft done" } } });
    expect(second.status(parked)).toMatchObject({ status: "recovery_required", activeSteps: { actuate: { recovery: { kind: "unknown" } } } });
    expect(calls).toEqual(["draft"]);
  });
});
