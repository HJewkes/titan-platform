import { LINEAR_GROWTH_LIMIT, hostileGlobs, linearGrowth } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { matchesAny } from "./bounds.js";

describe("matchesAny on a hostile glob", () => {
  it.each(hostileGlobs())("grows linearly with the path for $name", ({ glob, path }) => {
    const { ratio } = linearGrowth((size) => {
      const input = path(size);
      return () => matchesAny(input, [glob]);
    }, { from: 1, to: 1024 });
    expect(ratio).toBeLessThan(LINEAR_GROWTH_LIMIT);
  }, 60_000);
});
