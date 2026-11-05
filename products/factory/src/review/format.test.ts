import type { StepResult } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { membersOf } from "./format.js";

const HEAD = "a".repeat(40);

const step = (stepId: string, result: object): StepResult => ({ stepId, iteration: 0, agentId: null, signal: null, completedAt: "2026-10-30T00:00:00.000Z", data: { result } });

describe("membersOf", () => {
  it("lists each recorded member dispatch with its shape, and skips every other step", () => {
    const run = {
      stepResults: {
        [`review-preflight:0`]: step("review-preflight", { kind: "go" }),
        [`review-dispatch:${HEAD}:0`]: step(`review-dispatch:${HEAD}`, { kind: "started", name: "rv-1", profile: "reviewer", degraded: false }),
        [`review-dispatch:${HEAD}:adversary:0`]: step(`review-dispatch:${HEAD}:adversary`, { kind: "never-started", name: "rv-1-adv", profile: "fable-reviewer", degraded: false }),
        [`review-dispatch:${HEAD}:r2:0`]: step(`review-dispatch:${HEAD}:r2`, { kind: "refused", name: "rv-1-r2", profile: "reviewer", degraded: false, error: "DispatchError", message: "busy" }),
      },
    };

    expect(membersOf(run)).toEqual([
      { shape: "correctness", name: "rv-1", profile: "reviewer", dispatch: "started" },
      { shape: "adversary", name: "rv-1-adv", profile: "fable-reviewer", dispatch: "never-started" },
      { shape: "correctness", name: "rv-1-r2", profile: "reviewer", dispatch: "refused" },
    ]);
  });
});
