import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StepRoute } from "../routed-runner.js";
import { crashAt } from "../test-support/crash.js";
import type { FakeGitHub } from "@titan-design/github";
import type { FactoryHost } from "../host.js";
import { answerPendingGate, approveUntilSettled, gateId, landScenario } from "../test-support/land.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-land-crash-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

/** The path a behind PR takes: rules, behind, update, green, approval, green again, merge. */
const STEPS = ["land-rules", "ci-wait:0", "update-branch:0", "ci-wait:1", "ci-wait:2", "merge:0"];

/** A kill after the step's effect reached GitHub but before the run recorded the step. */
function hangAfterEffect(routes: readonly StepRoute[], stepId: string, entered: () => void): StepRoute[] {
  return routes.map((route) => ({
    ...route,
    runner: {
      run: async (input) => {
        const outcome = await route.runner.run(input);
        if (input.stepId !== stepId) return outcome;
        entered();
        return new Promise(() => undefined);
      },
    },
  }));
}

/** The crashed host still needs its gate answered to reach the later steps; stop once it has hung. */
async function approveUntil(host: FactoryHost, runId: string, fake: FakeGitHub, hung: Promise<void>): Promise<void> {
  let stopped = false;
  void hung.then(() => (stopped = true));
  while (!stopped) {
    answerPendingGate(host, runId, fake);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe.each(["before", "after"] as const)("land core killed %s a step's effect, then resumed", (phase) => {
  it.each(STEPS)("%s: every effect happens once and the approval gate is not reopened", async (stepId) => {
    const scenario = landScenario();
    scenario.fake.pr(1).behind = true;
    let entered!: () => void;
    const effectDone = new Promise<void>((resolve) => (entered = resolve));
    const crashRoutes = phase === "after" ? hangAfterEffect(scenario.routes, stepId, entered) : scenario.routes;
    const crash = crashAt({ dbPath: dbFile(), workflows: [scenario.workflow], routes: crashRoutes, hangAt: phase === "before" ? stepId : "never" });
    const runId = crash.crashed.runtime.start("land-test");
    const reached = phase === "before" ? crash.reached : effectDone;
    await approveUntil(crash.crashed, runId, scenario.fake, reached);

    const survivor = crash.takeOver(scenario.routes);
    await survivor.runtime.hydrate();
    await approveUntilSettled(survivor, runId, scenario.fake);
    const run = survivor.runtime.status(runId);
    const reopened = survivor.gates.get(gateId(runId, "approve-merge", 1));
    crash.dispose();

    expect(run?.status).toBe("completed");
    expect(scenario.fake.effects).toEqual({ createRef: 0, putContent: 0, createPr: 0, updateBranch: 1, merge: 1, rerunFailedJobs: 0 });
    expect(reopened).toBeUndefined();
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "merged", headSha: scenario.fake.pr(1).headSha });
  });
});
