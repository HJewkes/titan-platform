import { describe, expect, it } from "vitest";
import { enter } from "./entrance.js";
import { fadeUp } from "./video.js";

/** Every 20 ms from just before the entrance starts until well after it settles. */
const SAMPLES_S = Array.from({ length: 60 }, (_, i) => 0.9 + i * 0.02);
const START_S = 1;

describe("a text entrance", () => {
  it("a rising word is at full colour whenever it is visible", () => {
    // Arrange
    const risePx = 24;

    // Act
    const frames = SAMPLES_S.map((t) => enter(t, START_S, risePx));

    // Assert
    expect(frames.every((frame) => frame.opacity === 0 || frame.opacity === 1)).toBe(true);
    expect(frames.filter((frame) => frame.opacity === 0)).toHaveLength(SAMPLES_S.filter((t) => t <= START_S).length);
    expect(new Set(frames.map((frame) => frame.transform)).size).toBeGreaterThan(10);
    expect(frames.at(-1)).toEqual({ opacity: 1, transform: "translateY(0px)" });
  });

  it("a row rising on its cue is at full colour whenever it is visible", () => {
    // Arrange
    const risePx = 16;

    // Act
    const frames = SAMPLES_S.map((t) => fadeUp(t, START_S, risePx));

    // Assert
    expect(frames.every((frame) => frame.opacity === 0 || frame.opacity === 1)).toBe(true);
    expect(frames.at(-1)).toEqual({ opacity: 1, transform: "translateY(0px)" });
  });
});
