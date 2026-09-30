import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { routedRunner } from "../routed-runner.js";
import { fakeGitHub, githubPort } from "@titan-design/github";
import type { ShepherdDeps, WakeRequest } from "./phases.js";
import { REVIEW_STEPS, reviewRoutes } from "./review.js";
import { shepherdStoreRef } from "./store.js";
import { WAKE_STEPS, wakePhase, wakeRoutes } from "./wake.js";

const WAKE_FAMILIES = ["sh-wake", "sh-await-new-head"];
const REVIEW_FAMILIES = ["sh-review", "sh-await-verdict", "sh-merge-evidence"];
const ctx = {} as WorkflowContext;
const target = { repo: "octo/demo", pr: 1, round: 0, headSha: "abc123" };
const wakeRequest: WakeRequest = { kind: "ci-red", ...target, payload: {} };
const deps: ShepherdDeps = { port: githubPort(fakeGitHub().wire), store: shepherdStoreRef(), now: () => 0, sleep: async () => {}, agentChatBin: "agent-chat" };

/** The declared ids that belong to none of `families`, where a family is its prefix, `prefix:n` or `prefix-name`. */
function outside(families: readonly string[], steps: readonly StepDeclaration[]): string[] {
  const inFamily = (id: string) => families.some((prefix) => stepIdMatches(prefix, id) || id.startsWith(`${prefix}-`));
  return steps.map((step) => step.id).filter((id) => !inFamily(id));
}

describe("shepherd phase step families", () => {
  it("wake.ts declares only wake step ids, so a review step cannot be declared there", () => {
    expect(outside(WAKE_FAMILIES, WAKE_STEPS)).toEqual([]);
  });

  it("review.ts declares only review step ids, so a wake step cannot be declared there", () => {
    expect(outside(REVIEW_FAMILIES, REVIEW_STEPS)).toEqual([]);
  });

  it("registers no wake routes until the wake phase is implemented", () => {
    expect(wakeRoutes(deps)).toEqual([]);
  });

  it("pins sh-review-intent, sh-review, sh-await-verdict and sh-merge-evidence to review.ts, declared and routed there", () => {
    expect(REVIEW_STEPS.map((step) => step.id)).toEqual(["sh-review-intent", "sh-review", "sh-await-verdict", "sh-merge-evidence"]);
    expect(reviewRoutes(deps).map((route) => route.match)).toEqual(["sh-review-intent", "sh-review", "sh-await-verdict", "sh-merge-evidence"]);
    expect(WAKE_STEPS.map((step) => step.id)).not.toContain("sh-review-intent");
  });

  it("routes a call of sh-review-intent to its own route, never to sh-review, which would start a reviewer", () => {
    const runner = routedRunner(reviewRoutes(deps));

    expect(runner.routeFor(`sh-review-intent:${target.headSha}`)?.match).toBe("sh-review-intent");
    expect(runner.routeFor(`sh-review:${target.headSha}`)?.match).toBe("sh-review");
  });

  it("wakePhase reports the request unhandled with a reason", async () => {
    const outcome = await wakePhase(ctx, wakeRequest);

    expect(outcome.kind).toBe("unhandled");
    expect(outcome.kind === "unhandled" && outcome.reason.length).toBeGreaterThan(0);
  });
});
