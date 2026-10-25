import { linearRegExpSteps } from "@titan-design/fix-proof/linear-regexp";
import { LINEAR_WORK_LIMIT, hostileGlobs, linearWork } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { expandedWordMayBeAlias } from "./alias-command-word.js";

// A `/` makes the word a path before any glob is read, so the rows use `-`; the growing name is a store builtin.
describe("a glob command word that is a hostile glob", () => {
  it.each(hostileGlobs("-"))("grows linearly with the name for %s", (_name, { glob, path, steady }) => {
    const { ratio } = linearWork((size) => {
      const builtins = [path(size)];
      return () => expandedWordMayBeAlias(glob, builtins);
    }, { from: 1, to: 1024, steady, meter: linearRegExpSteps });
    expect(ratio).toBeLessThan(LINEAR_WORK_LIMIT);
  });
});
