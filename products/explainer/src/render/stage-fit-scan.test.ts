import { describe, expect, it } from "vitest";
import { scanMoments } from "./stage-fit-scan.js";

describe("the stage-fit scan's seek moments", () => {
  it("a beat ending just past a half second is still scanned forward only", () => {
    // Arrange
    const beats = [
      { id: "beat-01", startS: 0, durationS: 7.533 },
      { id: "beat-02", startS: 7.533, durationS: 6.02 },
    ];

    // Act
    const moments = scanMoments(beats);

    // Assert
    expect(moments.every((t, i) => i === 0 || t > moments[i - 1]!)).toBe(true);
    expect(moments.at(-1)).toBeCloseTo(7.533 + 6.02 - 0.05, 9);
    expect(moments.filter((t) => t < 7.533).at(-1)).toBeCloseTo(7.483, 9);
  });
});
