import { describe, expect, it } from "vitest";
import { minimumDetectableEffect } from "./power.js";

// Reference: sd * statsmodels 0.15.0 NormalIndPower().solve_power(effect_size=None, nobs1=n, alpha, power, ratio=0, alternative).
const cases = [
  { n: 30, sd: 0.5, alpha: 0.05, power: 0.8, sides: 2 as const, effect: 0.255748 },
  { n: 100, sd: 0.5, alpha: 0.05, power: 0.8, sides: 2 as const, effect: 0.140078 },
  { n: 30, sd: 1, alpha: 0.05, power: 0.9, sides: 2 as const, effect: 0.591819 },
  { n: 30, sd: 0.5, alpha: 0.05, power: 0.8, sides: 1 as const, effect: 0.226983 },
  { n: 12, sd: 0.4, alpha: 0.1, power: 0.8, sides: 2 as const, effect: 0.287105 },
  { n: 1, sd: 0.5, alpha: 0.05, power: 0.8, sides: 2 as const, effect: 1.400791 },
];

describe("minimumDetectableEffect", () => {
  it.each(cases)("matches statsmodels for n $n, sd $sd, alpha $alpha, power $power, $sides-sided", (options) => {
    expect(minimumDetectableEffect(options)).toBeCloseTo(options.effect, 3);
  });

  it("defaults to a two-sided test at alpha 0.05 and power 0.8", () => {
    expect(minimumDetectableEffect({ n: 30, sd: 0.5 })).toBeCloseTo(0.255748, 3);
  });

  it("rejects a non-positive case count and an out-of-range power", () => {
    expect(() => minimumDetectableEffect({ n: 0, sd: 0.5 })).toThrow(RangeError);
    expect(() => minimumDetectableEffect({ n: 30, sd: 0.5, power: 1 })).toThrow(RangeError);
  });
});
