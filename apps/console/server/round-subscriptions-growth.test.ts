import { linearRegExpSteps } from "@titan-design/fix-proof/linear-regexp";
import { LINEAR_WORK_LIMIT, hostileGlobs, linearWork } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { targetMatches } from "./round-subscriptions.js";

describe("targetMatches on a hostile glob", () => {
  it.each(hostileGlobs("-"))("grows linearly with the path for %s", (_name, { glob, path, steady }) => {
    const { ratio } = linearWork((size) => {
      const input = path(size);
      return () => targetMatches(glob, { id: input, unit: null, prs: [] });
    }, { from: 1, to: 1024, steady, meter: linearRegExpSteps });
    expect(ratio).toBeLessThan(LINEAR_WORK_LIMIT);
  });
});
