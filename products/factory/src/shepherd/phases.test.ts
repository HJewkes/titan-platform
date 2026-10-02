import { routedRunner } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { fakeGitHub, githubPort } from "@titan-design/github";
import type { ShepherdDeps } from "./phases.js";
import { REVIEW_STEPS, reviewRoutes } from "./review.js";
import { shepherdStoreRef } from "./store.js";
import { WAKE_STEPS, wakeRoutes } from "./wake.js";

const WAKE_FAMILIES = ["sh-wake", "sh-await-new-head"];
const REVIEW_FAMILIES = ["sh-review", "sh-await-verdict", "sh-late-verdict", "sh-merge-evidence", "sh-carry"];
const target = { repo: "octo/demo", pr: 1, round: 0, headSha: "abc123" };
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

  it("pins sh-wake-implementer, sh-await-new-head and sh-wake-fix-first to wake.ts, declared and routed there", () => {
    const ids = ["sh-wake-implementer", "sh-await-new-head", "sh-wake-fix-first"];
    expect(WAKE_STEPS.map((step) => step.id)).toEqual(ids);
    expect(wakeRoutes(deps).map((route) => route.match)).toEqual(ids);
  });

  it("pins sh-review-intent, sh-review, sh-await-verdict, sh-late-verdict, sh-merge-evidence and sh-carry to review.ts, declared and routed there", () => {
    const ids = ["sh-review-intent", "sh-review", "sh-await-verdict", "sh-late-verdict", "sh-merge-evidence", "sh-carry"];
    expect(REVIEW_STEPS.map((step) => step.id)).toEqual(ids);
    expect(reviewRoutes(deps).map((route) => route.match)).toEqual(ids);
    expect(WAKE_STEPS.map((step) => step.id)).not.toContain("sh-review-intent");
  });

  it("routes a call of sh-review-intent to its own route, never to sh-review, which would start a reviewer", () => {
    const runner = routedRunner(reviewRoutes(deps));

    expect(runner.routeFor(`sh-review-intent:${target.headSha}`)?.match).toBe("sh-review-intent");
    expect(runner.routeFor(`sh-review:${target.headSha}`)?.match).toBe("sh-review");
  });
});
