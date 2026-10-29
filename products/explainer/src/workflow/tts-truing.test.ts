import { describe, expect, it } from "vitest";
import { SETTLE_S, trueDuration } from "./tts-truing.js";

const PADDING = { leadS: 0.3, tailS: 0.6 };

describe("truing a beat to its voice", () => {
  it("a beat whose speech runs short ends a settle after its last word", () => {
    // Arrange
    const plannedS = 16;
    const speechS = 9;

    // Act
    const durationS = trueDuration(plannedS, speechS, PADDING);

    // Assert
    expect(durationS).toBeCloseTo(PADDING.leadS + speechS + PADDING.tailS + SETTLE_S, 6);
  });

  it("a short beat still lasts the beat floor", () => {
    // Arrange
    const plannedS = 12;
    const speechS = 2;

    // Act
    const durationS = trueDuration(plannedS, speechS, PADDING);

    // Assert
    expect(durationS).toBe(6);
  });

  it("a beat whose voice fills nearly all of its plan never runs past the plan", () => {
    // Arrange / Act
    const durationS = trueDuration(10, 8.5, PADDING);

    // Assert
    expect(durationS).toBe(10);
  });

  it("a held beat keeps its planned length however short its speech", () => {
    // Arrange / Act
    const durationS = trueDuration(14, 3, PADDING, true);

    // Assert
    expect(durationS).toBe(14);
  });

  it("a beat whose voice runs long still grows to fit it", () => {
    // Arrange / Act
    const durationS = trueDuration(8, 9, PADDING);

    // Assert
    expect(durationS).toBe(9.9);
  });
});
