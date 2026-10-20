import { describe, expect, it } from "vitest";
import { guidePlan } from "./guide-plan.js";

describe("guidePlan", () => {
  it("gives the plan stage the journey-first planner rule and the template's journey header", () => {
    const guide = guidePlan("plan");

    expect(guide).toContain("Open on the problem, then follow one task's journey");
    expect(guide).toContain("## 3. Journey: one task from");
    expect(guide).toContain("## Rules for the plan stage");
  });

  it("keeps code-enforced owner rules and their thresholds out of the guide", () => {
    const guide = guidePlan("plan");

    expect(guide).not.toContain("at most 4");
    expect(guide).not.toContain("Show only a few new on-screen items");
    expect(guide).not.toContain("owner-FB3");
  });
});
