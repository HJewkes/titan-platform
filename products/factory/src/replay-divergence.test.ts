import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "./definition.js";
import { openFactoryHost, type FactoryHost } from "./host.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const STEPS = [
  { id: "land-rules", kind: "dispatch" },
  { id: "approve-merge", kind: "assisted" },
  { id: "publish-review", kind: "dispatch" },
  { id: "ci-wait", kind: "dispatch" },
] as const;

/** Build N lands its rules and publishes the review before CI; build N+1 asks for the merge gate in between. */
function build(asksApproveMergeFirst: boolean): WorkflowDefinition {
  return defineWorkflow({
    name: "shepherd-pr",
    steps: STEPS,
    run: async (ctx) => {
      await ctx.dispatch("land-rules", "land-rules");
      if (asksApproveMergeFirst) {
        const brief = { summary: "Merge the PR? CI has not finished yet.", evidenceRef: "$ gh pr view 1" };
        await ctx.assisted("approve-merge", "Merge?", { schema: z.object({ approve: z.literal(true) }), brief });
      }
      await ctx.dispatch("publish-review", "publish-review");
      await ctx.dispatch("ci-wait", "ci-wait");
    },
  });
}

/** Each host stands in for one deploy: on the first, CI never reports, so the run is still in flight at the redeploy. */
function host(dbPath: string, definition: WorkflowDefinition, ciReports: boolean, calls: string[]): FactoryHost {
  const route = (match: string, settles: boolean): StepRoute => ({
    match,
    onRestart: "repeat",
    runner: { run: (input) => (calls.push(input.stepId), settles ? Promise.resolve({ ok: true, output: match }) : new Promise(() => undefined)) },
  });
  const routes = [route("land-rules", true), route("publish-review", true), route("ci-wait", ciReports)];
  const opened = openFactoryHost({ dbPath, workflows: [definition], routes, gatePollMs: 5 });
  hosts.push(opened);
  return opened;
}

async function inFlightOnBuildN(dbPath: string): Promise<string> {
  const first = host(dbPath, build(false), false, []);
  const runId = first.runtime.start("shepherd-pr");
  await vi.waitFor(() => expect(first.runtime.status(runId)?.stepResults).toHaveProperty(["publish-review:0"]));
  first.close();
  return runId;
}

describe("a shepherd-pr run recorded on one build and adopted by the next", () => {
  it("refuses a replay whose new build calls approve-merge before a recorded step, opening no gate", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp2574-")), "factory.db");
    const runId = await inFlightOnBuildN(dbPath);
    const calls: string[] = [];

    const second = host(dbPath, build(true), true, calls);
    await second.adopt();
    const run = await second.runtime.wait(runId);

    expect(run.status).toBe("recovery_required");
    expect(run.error).toMatch(/replay diverged: assisted\("approve-merge"\).*next publish-review:0/);
    expect(Object.keys(run.stepResults).filter((key) => key.startsWith("approve-merge"))).toEqual([]);
    expect(second.pendingGates()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("completes the same run when the redeploy kept the step order", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp2574-")), "factory.db");
    const runId = await inFlightOnBuildN(dbPath);
    const calls: string[] = [];

    const second = host(dbPath, build(false), true, calls);
    await second.adopt();
    const run = await second.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(calls).toEqual(["ci-wait"]);
  });
});
