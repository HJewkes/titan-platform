import { describe, expect, it } from "vitest";
import { armVerdict } from "./samples-compare.js";

describe("armVerdict", () => {
  const band = { min: 10, max: 20 };

  it("holds a diff of exactly 2σ as noise", () => {
    expect(armVerdict(band, 30, 28, 1)).toBe("noise");
    expect(armVerdict(band, 30, 27.99, 1)).toBe("win");
  });

  it("calls a big move inside the band a shift, neither a win nor a loss", () => {
    expect(armVerdict(band, 12, 18, 1)).toBe("shift");
  });

  it("judges a move toward a floor-only band from below as a win", () => {
    expect(armVerdict({ min: 13, max: Infinity }, 9, 12, 1)).toBe("win");
  });
});
