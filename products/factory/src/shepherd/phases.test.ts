import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { stepIdMatches } from "../definition.js";
import type { WakeRequest } from "./phases.js";
import { REVIEW_STEPS, reviewPhase, reviewRoutes } from "./review.js";
import { WAKE_STEPS, wakePhase, wakeRoutes } from "./wake.js";

const ALLOWED_PREFIXES = ["sh-wake", "sh-await-new-head", "sh-review", "sh-await-verdict"];
const ctx = {} as WorkflowContext;
const wakeRequest: WakeRequest = { kind: "ci-red", headSha: "abc123", payload: {} };

function inAllowedFamily(stepId: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => stepIdMatches(prefix, stepId) || stepId.startsWith(`${prefix}-`));
}

describe("shepherd phase stubs", () => {
  it("declare only step ids in the wake and review prefix families", () => {
    const foreign = [...WAKE_STEPS, ...REVIEW_STEPS].map((step) => step.id).filter((id) => !inAllowedFamily(id));

    expect(foreign).toEqual([]);
  });

  it("register no routes until the phases are implemented", () => {
    expect(wakeRoutes()).toEqual([]);
    expect(reviewRoutes()).toEqual([]);
  });

  it("wakePhase reports the request unhandled with a reason", async () => {
    const outcome = await wakePhase(ctx, wakeRequest);

    expect(outcome.kind).toBe("unhandled");
    expect(outcome.kind === "unhandled" && outcome.reason.length).toBeGreaterThan(0);
  });

  it("reviewPhase returns none so the owner gate keeps waiting, never MERGE", async () => {
    const verdict = await reviewPhase(ctx, { headSha: "abc123" });

    expect(verdict).toEqual({ kind: "none" });
  });
});
