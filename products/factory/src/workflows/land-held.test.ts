import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StepRoute } from "@titan-design/workflow";
import type { GatePolicy } from "../gate-policy.js";
import { AFTER_HOLD } from "../shepherd/hold.js";
import { crashAt } from "../test-support/crash.js";
import { landScenario } from "../test-support/land.js";
import { MAX_CI_CYCLES, codeRoute } from "./land.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-land-held-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

const allowMerges: GatePolicy = { decide: () => ({ outcome: "allow", rule: { table: "test", rowId: "allow-merge", version: 1 }, reason: "allowed" }) };

/** How the merge step answers at one step id: with the canned skip, or by merging once the promise resolves. */
type MergeAnswer = (stepId: string) => "canned" | Promise<void>;

/** Stands in for Shepherd's `waitWhileHeld`, which answers AFTER_HOLD once a held wait ends with no merge. */
function mergeAnswering(routes: readonly StepRoute[], answer: MergeAnswer, skipped = AFTER_HOLD): StepRoute[] {
  const canned = codeRoute("merge", () => 0, async () => skipped);
  return routes.map((route) => {
    if (route.match !== "merge") return route;
    return {
      ...route,
      runner: {
        run: async (input) => {
          const how = answer(input.stepId);
          if (how === "canned") return canned.runner.run(input);
          await how;
          return route.runner.run(input);
        },
      },
    };
  });
}

const ordinal = (stepId: string) => Number(stepId.split(":").at(-1));

describe("land with the merge held for an owner release", () => {
  it("keeps a run parked across a restart after 19 held merge cycles, and merges on the release", async () => {
    const scenario = landScenario({ policy: allowMerges });
    const crash = crashAt({ dbPath: dbFile(), workflows: [scenario.workflow], routes: mergeAnswering(scenario.routes, () => "canned"), hangAt: "merge:18" });
    const runId = crash.crashed.runtime.start("land-test");
    await crash.reached;

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let parked = false;
    const survivor = crash.takeOver(mergeAnswering(scenario.routes, (stepId) => (ordinal(stepId) <= 18 ? "canned" : ((parked = true), released))));
    await survivor.runtime.hydrate();
    await vi.waitFor(() => expect(parked || survivor.runtime.status(runId)?.status === "failed").toBe(true));
    const { status, error } = survivor.runtime.status(runId) ?? {};
    const whileParked = { status, error };
    release();
    await vi.waitFor(() => expect(survivor.runtime.status(runId)?.status).toMatch(/completed|failed/));
    const final = survivor.runtime.status(runId);
    crash.dispose();

    const merges = Object.values(final?.stepResults ?? {}).filter((row) => row.stepId.startsWith("merge:")).map((row) => row.stepId);
    expect(merges).toEqual(Array.from({ length: 20 }, (_, n) => `merge:${n}`));
    expect(whileParked?.error ?? null).toBeNull();
    expect(whileParked?.status).toBe("running");
    expect(final?.status).toBe("completed");
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "merged", own: true });
  });

  it("still fails a merge that never lands for another reason at the cycle limit", async () => {
    const scenario = landScenario({ policy: allowMerges });
    const crash = crashAt({ dbPath: dbFile(), workflows: [scenario.workflow], routes: mergeAnswering(scenario.routes, () => "canned", { done: false, skipped: "base-moved", mergeSha: "" }), hangAt: "never" });
    const runId = crash.crashed.runtime.start("land-test");

    await vi.waitFor(() => expect(crash.crashed.runtime.status(runId)?.status).toBe("failed"));
    const run = crash.crashed.runtime.status(runId);
    crash.dispose();

    expect(run?.error).toContain(`did not settle within ${MAX_CI_CYCLES} ci-wait cycles`);
  });
});
