import { describe, it, expect } from "vitest";
import { severityForConfidence, toEslintLevel } from "./severity.js";
import { DEFAULT_SEVERITY_THRESHOLDS } from "./profile.js";

describe("severityForConfidence", () => {
  it.each([
    [0.95, "error"],
    [0.7, "warn"],
    [0.5, "info"],
    [0.1, "off"],
  ] as const)("places confidence %s in the %s tier under the default thresholds", (confidence, tier) => {
    expect(severityForConfidence(confidence)).toBe(tier);
  });

  it("treats each threshold as the inclusive floor of its tier", () => {
    const { error, warn, info } = DEFAULT_SEVERITY_THRESHOLDS;

    expect(severityForConfidence(error)).toBe("error");
    expect(severityForConfidence(warn)).toBe("warn");
    expect(severityForConfidence(info)).toBe("info");
  });

  it("reads the tier boundaries from the profile's own thresholds", () => {
    const strict = { error: 0.95, warn: 0.8, info: 0.6 };

    expect(severityForConfidence(0.9, strict)).toBe("warn");
    expect(severityForConfidence(0.55, strict)).toBe("off");
  });
});

describe("toEslintLevel", () => {
  it("lints the info tier as a warning because ESLint has no info level", () => {
    expect(toEslintLevel("info")).toBe("warn");
  });

  it.each(["error", "warn", "off"] as const)("passes %s through unchanged", (level) => {
    expect(toEslintLevel(level)).toBe(level);
  });
});
