import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactoryHost } from "../host.js";
import { crashAt } from "../test-support/crash.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { landPrRoutes, landPrWorkflow } from "./land-pr.js";

const H2 = fakeSha("head2");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-land-pr-crash-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

/**
 * The run's path: H1 is cancelled, code reruns it once, it is cancelled again, a human answers ci-failed with
 * await-fix, someone pushes H2, H2 goes green, a human approves it, and it merges.
 */
const STEPS = ["ci-wait:0", "rerun:0", "ci-wait:r1:0", "await-new-head:0", "merge:r2:0"];

interface World {
  fake: FakeGitHub;
  routes: StepRoute[];
  /** Set once the ci-failed gate is answered: the next read of the PR shows the fix pushed as H2. */
  fixPushed: boolean;
}

function landPrWorld(): World {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  const world: World = { fake, routes: [], fixPushed: false };
  fake.onGetPr = (pr) => {
    if (world.fixPushed && pr.headSha === H1) pr.headSha = H2;
    const validate = pr.headSha === H2 ? successRun("validate", 5) : successRun("validate", fake.effects.rerunFailedJobs === 0 ? 1 : 3, undefined, "cancelled");
    fake.setRuns(pr.headSha, [validate, successRun("dag-check", 2)]);
  };
  let clock = 0;
  world.routes = landPrRoutes({ port: githubPort(fake.wire), now: () => clock, sleep: async (ms) => void (clock += ms) });
  return world;
}

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

/** Answer ci-failed with await-fix at the red head, and approve-merge at whatever head the PR shows now. */
function answerPendingGates(host: FactoryHost, runId: string, world: World): void {
  for (const { gate } of host.pendingGates().filter((pending) => pending.runId === runId)) {
    if (gate.id === gateId(runId, "ci-failed")) {
      host.runtime.signal(runId, "ci-failed", { decision: "await-fix", headSha: H1 }, OWNER);
      world.fixPushed = true;
    } else host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: world.fake.pr(1).headSha }, OWNER);
  }
}

/** The crashed host still needs its gates answered to reach the later steps; stop once it has hung. */
async function answerUntil(host: FactoryHost, runId: string, world: World, hung: Promise<void>): Promise<void> {
  let stopped = false;
  void hung.then(() => (stopped = true));
  while (!stopped) {
    answerPendingGates(host, runId, world);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function answerUntilSettled(host: FactoryHost, runId: string, world: World): Promise<void> {
  await vi.waitFor(
    () => {
      answerPendingGates(host, runId, world);
      expect(host.runtime.status(runId)?.status).toMatch(/completed|failed|recovery_required/);
    },
    { timeout: 4_000, interval: 10 },
  );
}

/** Every effect happened once, each gate opened once, and the approved H2 merged. */
function expectLandedOnce(survivor: FactoryHost, runId: string, world: World): void {
  expect(survivor.runtime.status(runId)?.status).toBe("completed");
  expect(world.fake.effects).toEqual({ createRef: 0, deleteRef: 0, putContent: 0, createPr: 0, updateBranch: 0, updateRef: 0, merge: 1, rerunFailedJobs: 1 });
  expect(world.fake.pr(1)).toMatchObject({ merged: true, headSha: H2 });
  expect(survivor.gates.get(gateId(runId, "ci-failed"))?.status).toBe("resolved");
  expect(survivor.gates.get(gateId(runId, "approve-merge"))?.status).toBe("resolved");
  expect(survivor.gates.get(gateId(runId, "ci-failed", 1))).toBeUndefined();
  expect(survivor.gates.get(gateId(runId, "approve-merge", 1))).toBeUndefined();
}

const workflows = [landPrWorkflow()];
const params = { repo: REPO, pr: "1" };

describe.each(["before", "after"] as const)("land-pr killed %s a step's effect, then taken over", (phase) => {
  it.each(STEPS)("%s: one rerun, one merge, and no gate reopened", async (stepId) => {
    const world = landPrWorld();
    let entered!: () => void;
    const effectDone = new Promise<void>((resolve) => (entered = resolve));
    const crashRoutes = phase === "after" ? hangAfterEffect(world.routes, stepId, entered) : world.routes;
    const crash = crashAt({ dbPath: dbFile(), workflows, routes: crashRoutes, hangAt: phase === "before" ? stepId : "never" });
    const runId = crash.crashed.runtime.start("land-pr", params);
    await answerUntil(crash.crashed, runId, world, phase === "before" ? crash.reached : effectDone);

    const survivor = crash.takeOver(world.routes);
    await survivor.runtime.hydrate();
    await answerUntilSettled(survivor, runId, world);

    try {
      expectLandedOnce(survivor, runId, world);
    } finally {
      crash.dispose();
    }
  });
});

describe("land-pr killed while the ci-failed gate is pending", () => {
  it("takes the same gate over, and its answer lands H2 with one rerun and one merge", async () => {
    const world = landPrWorld();
    const crash = crashAt({ dbPath: dbFile(), workflows, routes: world.routes, hangAt: "await-new-head:0" });
    const runId = crash.crashed.runtime.start("land-pr", params);
    await gateOpened(crash.crashed, gateId(runId, "ci-failed"));
    const opened = crash.crashed.gates.get(gateId(runId, "ci-failed"))!;

    const survivor = crash.takeOver(world.routes);
    await survivor.runtime.hydrate();
    const takenOver = survivor.gates.get(gateId(runId, "ci-failed"));
    await answerUntilSettled(survivor, runId, world);

    try {
      expect(takenOver).toMatchObject({ status: "pending", createdAt: opened.createdAt, prompt: opened.prompt });
      expectLandedOnce(survivor, runId, world);
    } finally {
      crash.dispose();
    }
  });
});
