import { describe, expect, it } from "vitest";
import { assertDistinctStepIds, defineWorkflow, dispatchStepIds, type WorkflowDefinition } from "./definition.js";
import { openFactoryHost } from "./host.js";
import { routedRunner, type StepRoute } from "@titan-design/workflow";
import { factoryRoutes, factoryWorkflows } from "./workflows.js";
import { TEST_BRIEF } from "./test-support/brief.js";

const route: StepRoute = { match: "draft", onRestart: "repeat", runner: { run: async () => ({ ok: true, output: "{}" }) } };

function docShaped(approveId: string, callApproveAs = approveId): WorkflowDefinition {
  return defineWorkflow({
    name: "doc-shaped",
    steps: [
      { id: "draft", kind: "dispatch" },
      { id: approveId, kind: "assisted" },
    ],
    run: async (ctx) => {
      await ctx.dispatch("draft", "draft");
      await ctx.assisted(callApproveAs, "Publish?", { brief: TEST_BRIEF });
    },
  });
}

describe("step ids (TP-255 guard)", () => {
  it("every registered workflow uses each step id for one operation kind and routes every dispatch", () => {
    const runner = routedRunner(factoryRoutes());
    for (const workflow of factoryWorkflows) {
      expect(() => assertDistinctStepIds(workflow)).not.toThrow();
      expect(() => runner.assertRoutes(workflow.name, dispatchStepIds(workflow))).not.toThrow();
    }
  });

  it("registers shepherd-pr and routes each step family exactly once, including those it shares with land-pr", () => {
    const matches = factoryRoutes().map((route) => route.match);

    expect(factoryWorkflows.map((workflow) => workflow.name)).toEqual(expect.arrayContaining(["land-pr", "shepherd-pr"]));
    expect(matches.filter((match, index) => matches.indexOf(match) !== index)).toEqual([]);
  });

  it("refuses a declaration that gives one id two kinds", () => {
    expect(() => assertDistinctStepIds(docShaped("draft"))).toThrow(/"draft" is declared as both dispatch and assisted/);
  });

  it("fails a run whose code calls a declared dispatch id as a gate, without opening the gate", async () => {
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [docShaped("approve-publish", "draft")], routes: [route] });

    const run = await host.runtime.wait(host.runtime.start("doc-shaped"));
    const gates = host.gates.listPending();
    host.close();

    expect(run).toMatchObject({ status: "failed", error: expect.stringContaining('assisted("draft") does not match a declared assisted step') });
    expect(gates).toEqual([]);
  });
});
