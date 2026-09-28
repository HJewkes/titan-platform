import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "./definition.js";
import { openFactoryHost } from "./host.js";
import { routedRunner, type RestartRule, type StepRoute } from "./routed-runner.js";
import { crashAt } from "./test-support/crash.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-router-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

function countingRoute(match: string, onRestart: RestartRule, calls: string[]): StepRoute {
  return { match, onRestart, runner: { run: async (input) => (calls.push(input.stepId), { ok: true, output: `${match} done` }) } };
}

const pilot = defineWorkflow({
  name: "pilot",
  steps: [
    { id: "load", kind: "seed" },
    { id: "draft", kind: "dispatch" },
    { id: "branch", kind: "dispatch" },
    { id: "actuate", kind: "dispatch" },
  ],
  run: async (ctx) => {
    await ctx.seed("load", async () => ({ data: { task: "t1" } }));
    await ctx.dispatch("draft", "draft {{task}}");
    await ctx.dispatch("branch", "branch");
    if (ctx.param("withDevice") === "yes") await ctx.dispatch("actuate", "actuate");
  },
});

describe("routedRunner", () => {
  it("sends each step to the runner its route names", async () => {
    const model: string[] = [];
    const code: string[] = [];
    const host = openFactoryHost({
      dbPath: ":memory:",
      workflows: [pilot],
      routes: [countingRoute("draft", "repeat", model), countingRoute("branch", "repeat", code), countingRoute("actuate", "park", code)],
    });

    const run = await host.runtime.wait(host.runtime.start("pilot"));
    host.close();

    expect(run.status).toBe("completed");
    expect(model).toEqual(["draft"]);
    expect(code).toEqual(["branch"]);
  });

  it("matches a step family by id segment and prefers the longest route", () => {
    const calls: string[] = [];
    const runner = routedRunner([countingRoute("ci-wait", "repeat", calls), countingRoute("ci-wait:final", "park", calls)]);

    expect(runner.routeFor("ci-wait:2")?.match).toBe("ci-wait");
    expect(runner.routeFor("ci-wait:final")?.onRestart).toBe("park");
    expect(runner.routeFor("ci-waiting")).toBeUndefined();
  });

  it("refuses to register a workflow whose dispatch step has no route, before any run starts", () => {
    const create = () => openFactoryHost({ dbPath: ":memory:", workflows: [pilot], routes: [countingRoute("draft", "repeat", [])] });

    expect(create).toThrow(/no route for branch, actuate/);
  });

  it("repeats a repeat-routed step after a crash without re-running the steps that finished", async () => {
    const calls: string[] = [];
    const routes = [countingRoute("draft", "repeat", calls), countingRoute("branch", "repeat", calls), countingRoute("actuate", "park", calls)];
    const crash = crashAt({ dbPath: dbFile(), workflows: [pilot], routes, hangAt: "branch" });
    const runId = crash.crashed.runtime.start("pilot");
    await crash.reached;

    const report = await crash.takeOver().resume();
    crash.dispose();

    expect(report.resumed.map((run) => [run.id, run.status])).toEqual([[runId, "completed"]]);
    expect(calls).toEqual(["draft", "branch"]);
    expect(report.resumed[0]?.stepResults["branch:0"]?.agentId).toMatch(/:branch:0:1$/);
  });

  it("parks a park-routed step as recovery_required after a crash and never dispatches it again", async () => {
    const calls: string[] = [];
    const routes = [countingRoute("draft", "repeat", calls), countingRoute("branch", "repeat", calls), countingRoute("actuate", "park", calls)];
    const crash = crashAt({ dbPath: dbFile(), workflows: [pilot], routes, hangAt: "actuate" });
    const runId = crash.crashed.runtime.start("pilot", { withDevice: "yes" });
    await crash.reached;

    const report = await crash.takeOver().resume();
    crash.dispose();

    expect(report.resumed).toEqual([]);
    expect(report.held).toMatchObject([{ reason: "recovery_required", run: { id: runId, status: "recovery_required" } }]);
    expect(calls).toEqual(["draft", "branch"]);
  });
});
