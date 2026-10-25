import { LINEAR_GROWTH_LIMIT, hostileGlobs, linearGrowth } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { matchesGlob } from "./glob.js";

describe("matchesGlob on a hostile glob", () => {
  it.each(hostileGlobs())("grows linearly with the path for %s", (_name, { glob, path }) => {
    const { ratio } = linearGrowth((size) => {
      const input = path(size);
      return () => matchesGlob(input, glob);
    }, { from: 1, to: 1024 });
    expect(ratio).toBeLessThan(LINEAR_GROWTH_LIMIT);
  }, 60_000);
});
