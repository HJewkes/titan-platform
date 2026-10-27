import { linearRegExpSteps } from "@titan-design/fix-proof/linear-regexp";
import { LINEAR_WORK_LIMIT, hostileGlobs, linearWork } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { gitattributesPatternToRegex, parseGeneratedPatterns } from "./generated.js";

const LADDER = { from: 1, to: 1024, meter: linearRegExpSteps };

describe("a .gitattributes pattern that is a hostile glob", () => {
  it.each(hostileGlobs())("grows linearly with the path for %s", (_name, { glob, path, steady }) => {
    const regexp = gitattributesPatternToRegex(glob);
    const { ratio } = linearWork((size) => {
      const input = path(size);
      return () => regexp.test(input);
    }, { ...LADDER, steady });
    expect(ratio).toBeLessThan(LINEAR_WORK_LIMIT);
  });

  it.each(hostileGlobs())("grows linearly with the path for %s under a later opt-out line", (_name, { glob, path, steady }) => {
    const patterns = parseGeneratedPatterns(`* linguist-generated\n${glob} -linguist-generated\n`);
    expect(patterns).toHaveLength(1);
    const { ratio } = linearWork((size) => {
      const input = path(size);
      return () => patterns.some((regexp) => regexp.test(input));
    }, { ...LADDER, steady });
    expect(ratio).toBeLessThan(LINEAR_WORK_LIMIT);
  });
});
