import { describe, it, expect } from "vitest";
import {
  computeConfidence,
  mapSeverity,
  DEFAULT_STABILITY_WEIGHTS,
  DEFAULT_SEVERITY_THRESHOLDS,
} from "./confidence.js";

describe("computeConfidence", () => {
  const weights = DEFAULT_STABILITY_WEIGHTS;

  it("returns consistency * 1.0 for high stability", () => {
    expect(computeConfidence(0.9, "high", weights)).toBeCloseTo(0.9, 2);
  });

  it("returns consistency * 0.85 for medium stability", () => {
    expect(computeConfidence(0.9, "medium", weights)).toBeCloseTo(0.765, 2);
  });

  it("returns consistency * 0.7 for low stability", () => {
    expect(computeConfidence(0.9, "low", weights)).toBeCloseTo(0.63, 2);
  });

  it("returns 0 for zero consistency", () => {
    expect(computeConfidence(0, "high", weights)).toBe(0);
  });

  it("clamps to 1.0 maximum", () => {
    expect(computeConfidence(1.0, "high", weights)).toBe(1.0);
  });

  it("handles perfect consistency with low stability", () => {
    expect(computeConfidence(1.0, "low", weights)).toBeCloseTo(0.7, 2);
  });

  it("handles partial consistency with medium stability", () => {
    expect(computeConfidence(0.5, "medium", weights)).toBeCloseTo(0.425, 2);
  });
});

describe("mapSeverity", () => {
  const thresholds = DEFAULT_SEVERITY_THRESHOLDS;

  it("maps >= 0.85 to error", () => {
    expect(mapSeverity(0.85, thresholds)).toBe("error");
    expect(mapSeverity(0.95, thresholds)).toBe("error");
    expect(mapSeverity(1.0, thresholds)).toBe("error");
  });

  it("maps >= 0.60 to warn", () => {
    expect(mapSeverity(0.6, thresholds)).toBe("warn");
    expect(mapSeverity(0.7, thresholds)).toBe("warn");
    expect(mapSeverity(0.84, thresholds)).toBe("warn");
  });

  it("maps >= 0.40 to info", () => {
    expect(mapSeverity(0.4, thresholds)).toBe("info");
    expect(mapSeverity(0.5, thresholds)).toBe("info");
    expect(mapSeverity(0.59, thresholds)).toBe("info");
  });

  it("maps < 0.40 to off", () => {
    expect(mapSeverity(0.39, thresholds)).toBe("off");
    expect(mapSeverity(0.1, thresholds)).toBe("off");
    expect(mapSeverity(0, thresholds)).toBe("off");
  });

  it("respects custom thresholds", () => {
    const strict = { error: 0.95, warn: 0.8, info: 0.6 };
    expect(mapSeverity(0.9, strict)).toBe("warn");
    expect(mapSeverity(0.75, strict)).toBe("info");
    expect(mapSeverity(0.55, strict)).toBe("off");
  });
});
