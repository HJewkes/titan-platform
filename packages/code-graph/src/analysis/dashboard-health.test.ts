import { describe, it, expect } from "vitest";
import { computeHealth } from "./dashboard-health.js";

describe("computeHealth", () => {
  it("is 100 with a clean repo and every component reads 0", () => {
    const { health, healthBreakdown } = computeHealth({
      scary: 0, newViolations: 0, carryViolations: 0, maxComplexity: 10, hiddenCoupling: 0,
    });
    expect(health).toBe(100);
    expect(healthBreakdown.every((c) => c.penalty === 0)).toBe(true);
  });

  it("does NOT double-count a scary hotspot that is also a fitness violation", () => {
    // The caller passes scary-hotspots-rule violations as 0 (they're owned by the
    // hotspots component). A scary file must cost only its hotspot penalty.
    const scaryOnly = computeHealth({
      scary: 2, newViolations: 0, carryViolations: 0, maxComplexity: 10, hiddenCoupling: 0,
    });
    expect(scaryOnly.health).toBe(80); // 100 - min(30, 2*10)
    const hotspots = scaryOnly.healthBreakdown.find((c) => c.label === "scary hotspots");
    const violations = scaryOnly.healthBreakdown.find((c) => c.label === "fitness violations");
    expect(hotspots!.penalty).toBe(20);
    expect(violations!.penalty).toBe(0);
  });

  it("has no ownership (knowledge-silo) health component — it lives on the Ownership tab", () => {
    const { healthBreakdown } = computeHealth({
      scary: 0, newViolations: 0, carryViolations: 0, maxComplexity: 10, hiddenCoupling: 0,
    });
    expect(healthBreakdown.some((c) => /silo|bus factor|ownership/i.test(c.label))).toBe(false);
  });

  it("caps each component and floors the score at 0", () => {
    const { health, healthBreakdown } = computeHealth({
      scary: 99, newViolations: 99, carryViolations: 99, maxComplexity: 999, hiddenCoupling: 99,
    });
    expect(healthBreakdown.map((c) => c.penalty)).toEqual([30, 20, 15, 10]);
    expect(health).toBe(25); // 100 - 75
  });
});
