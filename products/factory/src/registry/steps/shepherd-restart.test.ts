import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepRoute, WorkflowRun } from "@titan-design/workflow";
import { afterAll, describe, expect, it, vi } from "vitest";
import { defineWorkflow, dispatchStepIds } from "../../definition.js";
import { openFactoryHost } from "../../host.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** The Shepherd reads S4 classified `read`: each body only reads GitHub or the store, so an orphan holds no write. */
const READ_STEPS = ["sh-flake-check", "sh-fix-proof", "sh-review-stop", "sh-main-ci", "sh-conflict-check", "sh-stale-base", "sh-merge-main", "sh-base-wait", "sh-held-wait"];

/** The S4 rows kept non-read, each with the write its body performs. */
const KEPT_STEPS: readonly (readonly [string, string])[] = [
  ["sh-await-pr", "it stores the PR number and places the registration hold"],
  ["sh-await-new-head", "it marks an exited fixer's account exhausted"],
  ["sh-account-wait", "it releases the run's account claim on a closed PR"],
  ["sh-review-request", "it takes the seat's review ask"],
  ["sh-no-reviewer-wait", "it releases the no-reviewer hold on a closed PR"],
  ["sh-release-preflight", "it records the release-ready head"],
  ["sh-release-follow", "it files a fix task for a failed release job"],
  ["sh-freeze-wait", "it thaws the freeze when main reads green"],
];

/** Build N records `before`, then blocks on `orphan`; build N+1 replays `before` and takes a branch that never reaches it. */
async function replaySkipping(orphan: string): Promise<{ recorded: WorkflowRun; replayed: WorkflowRun }> {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-restart-"));
  dirs.push(dir);
  const dbPath = join(dir, "factory.db");
  let replaying = false;
  const family = orphan.slice(0, orphan.indexOf(":"));
  const workflow = defineWorkflow({
    name: "shepherd-pr",
    steps: [{ id: "before", kind: "dispatch" }, { id: family, kind: "dispatch" }, { id: "after", kind: "dispatch" }],
    run: async (ctx) => {
      await ctx.dispatch("before", "before");
      if (!replaying) await ctx.dispatch(orphan, "read");
      await ctx.dispatch("after", "after");
    },
  });
  const routes = (stuck: string): StepRoute[] => dispatchStepIds(workflow).map((match) => ({
    match,
    onRestart: "repeat",
    runner: { run: (input) => (input.stepId === stuck ? new Promise(() => undefined) : Promise.resolve({ ok: true, output: `${input.stepId} done` })) },
  }));
  const first = openFactoryHost({ dbPath, workflows: [workflow], routes: routes(orphan) });
  const runId = first.runtime.start("shepherd-pr");
  await vi.waitFor(() => expect(first.runtime.status(runId)?.activeSteps[orphan]).toBeDefined());
  const recorded = structuredClone(first.runtime.status(runId)!);
  first.close();
  replaying = true;
  const second = openFactoryHost({ dbPath, workflows: [workflow], routes: routes("none") });
  try {
    await second.adopt();
    return { recorded, replayed: await second.runtime.wait(runId) };
  } finally {
    second.close();
  }
}

describe("Shepherd READ review (TP-3106 S4)", () => {
  it.each(READ_STEPS)("a restart whose replay diverged before %s drops its orphan and the run continues, not parks", async (stepId) => {
    const { recorded, replayed } = await replaySkipping(`${stepId}:0`);

    expect(replayed.status).toBe("completed");
    expect(replayed.activeSteps).toEqual({});
    expect(replayed.stepResults["before:0"]).toEqual(recorded.stepResults["before:0"]);
    expect(Object.keys(replayed.stepResults).sort()).toEqual(["after:0", "before:0"]);
  });

  it.each(KEPT_STEPS)("%s's orphan still parks because %s", async (stepId) => {
    const { replayed } = await replaySkipping(`${stepId}:0`);

    expect(replayed.status).toBe("recovery_required");
    expect(replayed.error).toBe(`replay never reached recovered step ${stepId}:0`);
  });
});
