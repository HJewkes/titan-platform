import { describe, expect, it } from "vitest";
import { LINEAR_WORK_LIMIT, linearWork } from "./linear-work.js";

/** A meter and an operation that adds `cost(size)` to it, standing in for an engine's step counter. */
function metered(cost: (size: number) => number) {
  let total = 0;
  const sizes: number[] = [];
  const prepare = (size: number) => () => {
    sizes.push(size);
    total += cost(size);
  };
  return { prepare, meter: () => total, sizes };
}

describe("linearWork", () => {
  it("passes work linear in the size, with a fixed cost on top", () => {
    const { prepare, meter } = metered((size) => 30 * size + 500);

    const { ratio } = linearWork(prepare, { from: 1, to: 1024, meter });

    expect(ratio).toBeLessThan(LINEAR_WORK_LIMIT);
  });

  it("fails quadratic work and stops at the first rung past the limit", () => {
    const { prepare, meter, sizes } = metered((size) => size * size);

    const growth = linearWork(prepare, { from: 1, to: 1024, meter });

    expect(growth.ratio).toBeGreaterThanOrEqual(LINEAR_WORK_LIMIT);
    expect(Math.max(...sizes)).toBe(growth.size);
    expect(growth.size).toBeLessThan(1024);
  });

  it("judges only rungs from `steady` on, so a pattern's states waking one per character read as linear", () => {
    const { prepare, meter } = metered((size) => (size < 16 ? size * size : 12 * size));

    expect(linearWork(prepare, { from: 1, to: 1024, meter }).ratio).toBeGreaterThanOrEqual(LINEAR_WORK_LIMIT);
    expect(linearWork(prepare, { from: 1, to: 1024, meter, steady: 16 }).ratio).toBeLessThan(LINEAR_WORK_LIMIT);
  });

  it("fails an operation the meter never counts, as a matcher that left the counted engine", () => {
    const { prepare } = metered((size) => size);

    expect(linearWork(prepare, { from: 1, to: 64, meter: () => 0 }).ratio).toBe(Infinity);
  });
});
