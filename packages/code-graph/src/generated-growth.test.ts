import { LINEAR_GROWTH_LIMIT, hostileGlobs, linearGrowth } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { gitattributesPatternToRegex, parseGeneratedPatterns } from "./generated.js";

const LADDER = { from: 1, to: 1024 };

describe("a .gitattributes pattern that is a hostile glob", () => {
  it.each(hostileGlobs())("grows linearly with the path for $name", ({ glob, path }) => {
    const regexp = gitattributesPatternToRegex(glob);
    const { ratio } = linearGrowth((size) => {
      const input = path(size);
      return () => regexp.test(input);
    }, LADDER);
    expect(ratio).toBeLessThan(LINEAR_GROWTH_LIMIT);
  }, 60_000);

  it.each(hostileGlobs())("grows linearly with the path for $name under a later opt-out line", ({ glob, path }) => {
    const patterns = parseGeneratedPatterns(`* linguist-generated\n${glob} -linguist-generated\n`);
    expect(patterns).toHaveLength(1);
    const { ratio } = linearGrowth((size) => {
      const input = path(size);
      return () => patterns.some((regexp) => regexp.test(input));
    }, LADDER);
    expect(ratio).toBeLessThan(LINEAR_GROWTH_LIMIT);
  }, 60_000);
});
