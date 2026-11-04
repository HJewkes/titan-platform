import { describe, expect, it } from "vitest";
import { changedShare, emphasisStepChanges } from "./emphasis-change.js";
import { frame } from "./emphasis-fixtures.test-helpers.js";

const target = { x: 0, y: 0, width: 10, height: 10 };

describe("emphasis step change", () => {
  it("finds no change between identical marks", () => {
    const step = { before: frame(20, 20), after: frame(20, 20), target };

    expect(changedShare(step)).toBe(0);
    expect(emphasisStepChanges(step)).toBe(false);
  });

  it("finds a change when the target's pixels move", () => {
    const step = { before: frame(20, 20), after: frame(20, 20, { x: 2, y: 2, width: 5, height: 5, level: 200 }), target };

    expect(changedShare(step)).toBe(0.25);
    expect(emphasisStepChanges(step)).toBe(true);
  });

  it("ignores a change outside the target box", () => {
    const step = { before: frame(20, 20), after: frame(20, 20, { x: 12, y: 12, width: 5, height: 5, level: 200 }), target };

    expect(emphasisStepChanges(step)).toBe(false);
  });

  it.each([
    ["does not count a pixel moved by the channel tolerance", 48, false],
    ["counts a pixel moved just past the channel tolerance", 49, true],
  ])("%s", (_name, level, changed) => {
    const step = { before: frame(20, 20), after: frame(20, 20, { x: 0, y: 0, width: 10, height: 10, level }), target };

    expect(emphasisStepChanges(step)).toBe(changed);
  });

  it.each([
    ["does not pass a step that changes 1 % of the box", 1, false],
    ["passes a step that changes 2 % of the box", 2, true],
  ])("%s", (_name, pixels, changed) => {
    const step = { before: frame(20, 20), after: frame(20, 20, { x: 0, y: 0, width: pixels, height: 1, level: 200 }), target };

    expect(emphasisStepChanges(step)).toBe(changed);
  });

  it("counts only the on-frame part of a box that runs off the frame", () => {
    const after = frame(20, 20, { x: 15, y: 15, width: 5, height: 5, level: 200 });

    expect(changedShare({ before: frame(20, 20), after, target: { x: 15, y: 15, width: 10, height: 10 } })).toBe(1);
    expect(changedShare({ before: frame(20, 20), after, target: { x: 30, y: 30, width: 5, height: 5 } })).toBe(0);
  });

  it("refuses marks of different sizes", () => {
    expect(() => changedShare({ before: frame(20, 20), after: frame(10, 20), target })).toThrow(/differ in size/);
  });
});
