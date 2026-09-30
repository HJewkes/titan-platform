import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { stepIdMatches } from "../definition.js";
import { fakeGitHub, githubPort } from "@titan-design/github";
import type { ShepherdDeps, WakeRequest } from "./phases.js";
import { REVIEW_STEPS, reviewPhase, reviewRoutes } from "./review.js";
import { shepherdStoreRef } from "./store.js";
import { WAKE_STEPS, wakePhase, wakeRoutes } from "./wake.js";

const ALLOWED_PREFIXES = ["sh-wake", "sh-await-new-head", "sh-review", "sh-await-verdict", "sh-merge-evidence"];
const ctx = {} as WorkflowContext;
const target = { repo: "octo/demo", pr: 1, round: 0, headSha: "abc123" };
const wakeRequest: WakeRequest = { kind: "ci-red", ...target, payload: {} };
const deps: ShepherdDeps = { port: githubPort(fakeGitHub().wire), store: shepherdStoreRef(), now: () => 0, sleep: async () => {}, agentChatBin: "agent-chat" };

function inAllowedFamily(stepId: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => stepIdMatches(prefix, stepId) || stepId.startsWith(`${prefix}-`));
}

describe("shepherd phase stubs", () => {
  it("declare only step ids in the wake and review prefix families", () => {
    const foreign = [...WAKE_STEPS, ...REVIEW_STEPS].map((step) => step.id).filter((id) => !inAllowedFamily(id));

    expect(foreign).toEqual([]);
  });

  it("registers no wake routes until the wake phase is implemented", () => {
    expect(wakeRoutes(deps)).toEqual([]);
  });

  it("pins sh-await-verdict and sh-merge-evidence to review.ts, declared and routed there", () => {
    expect(REVIEW_STEPS.map((step) => step.id)).toEqual(["sh-await-verdict", "sh-merge-evidence"]);
    expect(reviewRoutes(deps).map((route) => route.match)).toEqual(["sh-await-verdict", "sh-merge-evidence"]);
  });

  it("wakePhase reports the request unhandled with a reason", async () => {
    const outcome = await wakePhase(ctx, wakeRequest);

    expect(outcome.kind).toBe("unhandled");
    expect(outcome.kind === "unhandled" && outcome.reason.length).toBeGreaterThan(0);
  });

  it("reviewPhase returns none so the owner gate keeps waiting, never MERGE", async () => {
    const verdict = await reviewPhase(ctx, target);

    expect(verdict).toEqual({ kind: "none" });
  });
});
