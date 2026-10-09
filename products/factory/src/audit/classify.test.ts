import { describe, expect, it } from "vitest";
import { proposedMetrics } from "../test-support/audit.js";
import { classify, isDeclaredSurface, rankSlices } from "./classify.js";
import { AUDIT_MANIFEST, MEASUREMENT_AUDIT_STEPS } from "./manifest.js";

describe("the measurement-audit manifest", () => {
  it("lists the design's eleven steps in order, each with its runner", () => {
    expect(AUDIT_MANIFEST.map((step) => `${step.name}:${step.runner}`)).toEqual([
      "load:code",
      "inventory-data:code",
      "inventory-code:agent",
      "purpose:agent",
      "answerability:code+agent",
      "propose:agent",
      "baseline:code",
      "gaps:code+agent",
      "plan:agent",
      "review:hitl",
      "publish:code",
    ]);
  });

  it("gives every agent step a model, and declares review as the one gate", () => {
    const agentSteps = AUDIT_MANIFEST.filter((step) => step.runner === "agent");
    expect(agentSteps.every((step) => step.model !== undefined)).toBe(true);
    expect(MEASUREMENT_AUDIT_STEPS.filter((step) => step.kind === "assisted").map((step) => step.id)).toEqual(["audit-review"]);
  });
});

describe("classify", () => {
  const [claimedY] = proposedMetrics();

  it("keeps a claimed Y only when its baseline has data", () => {
    expect(classify(claimedY!, { value: 4, n: 4 })).toBe("Y");
    expect(classify(claimedY!, { value: null, n: 0 })).toBe("P");
    expect(classify(claimedY!, { value: null, n: 0, error: "timeout" })).toBe("P");
  });

  it("never promotes a claimed P or N on data alone", () => {
    expect(classify({ ...claimedY!, source: { ...claimedY!.source, captured: "N" } }, { value: 4, n: 4 })).toBe("N");
  });
});

describe("rankSlices", () => {
  const metrics = proposedMetrics();
  const slice = (title: string, metric: string, unblocks: number[], estimate: 1 | 2 | 3) => ({ title, done_when: "done", estimate, metrics: [metric], unblocks });

  it("ranks by questions unblocked times family weight over estimate, then appends the registry entry", () => {
    const ranked = rankSlices("shepherd", [slice("cost", "shepherd.cost.m2", [1, 2], 1), slice("owner", "shepherd.owner-load.m4", [1], 1), slice("slow", "shepherd.flow.m9", [1, 2, 3], 3)], metrics);

    expect(ranked.map((gap) => [gap.rank, gap.slice.title])).toEqual([
      [1, "owner"],
      [2, "cost"],
      [3, "slow"],
      [4, "metrics/shepherd.yml registry entry"],
    ]);
  });
});

describe("isDeclaredSurface", () => {
  const surfaces = [{ kind: "cli" as const, ref: "titan-factory shepherd stats" }];

  it("accepts the surface command and its flags, and nothing else", () => {
    expect(isDeclaredSurface("titan-factory shepherd stats --json", surfaces)).toBe(true);
    expect(isDeclaredSurface("titan-factory shepherd statsx", surfaces)).toBe(false);
    expect(isDeclaredSurface("rm -rf /", surfaces)).toBe(false);
  });
});
