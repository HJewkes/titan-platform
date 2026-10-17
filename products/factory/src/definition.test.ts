import type { AuthorizeRequest, WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it, vi } from "vitest";
import { defineWorkflow, guardedContext, orphanSafe } from "./definition.js";
import { SHEPHERD_STEPS } from "./shepherd/shepherd-steps.js";

const REQUEST: AuthorizeRequest = { action: "merge", subject: { repo: "example/widgets", pr: "7", headSha: "a1b2c3" } };

function fakeContext(): WorkflowContext {
  const unused = (): never => {
    throw new Error("not used here");
  };
  return {
    runId: "run-1",
    workflowName: "governed",
    signal: new AbortController().signal,
    param: () => undefined,
    iteration: () => 0,
    historyNext: () => undefined,
    resumedGate: () => undefined,
    recoveredInFlight: () => [],
    expireGates: () => [],
    dispatch: unused,
    seed: unused,
    assisted: unused,
    authorize: vi.fn(async () => ({ verdict: "allow" as const, ruleId: "MRG-OT" })),
  };
}

const definition = defineWorkflow({
  name: "governed",
  steps: [
    { id: "merge-authorize", kind: "authorize" },
    { id: "approve", kind: "assisted" },
  ],
  run: async () => undefined,
});

describe("guardedContext authorize", () => {
  it("passes a declared authorize step through to the runtime context", async () => {
    const ctx = fakeContext();

    await expect(guardedContext(ctx, definition).authorize("merge-authorize", REQUEST)).resolves.toEqual({ verdict: "allow", ruleId: "MRG-OT" });

    expect(ctx.authorize).toHaveBeenCalledWith("merge-authorize", REQUEST, undefined);
  });

  it("refuses authorize on a step declared assisted without reaching the runtime", async () => {
    const ctx = fakeContext();

    await expect(guardedContext(ctx, definition).authorize("approve", REQUEST)).rejects.toThrow('authorize("approve") does not match a declared authorize step');

    expect(ctx.authorize).not.toHaveBeenCalled();
  });
});

describe("orphanSafe", () => {
  const shepherd = orphanSafe(defineWorkflow({ name: "shepherd-pr", steps: SHEPHERD_STEPS, run: async () => undefined }));

  it("allows dropping the read-only land and observe steps, matched by family", () => {
    expect(["ci-wait:r3:17", "land-rules:r4", "base-check:r4:0", "sh-observe:456a09"].filter(shepherd)).toHaveLength(4);
  });

  it("refuses steps that write, and ids no declaration covers", () => {
    expect(["merge:r4:0", "update-branch:r3:16", "rerun:2", "approve-merge", "sh-landed", "ci-wait-long:1"].filter(shepherd)).toEqual([]);
  });
});
