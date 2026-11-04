import { linearRegExpSteps } from "@titan-design/fix-proof/linear-regexp";
import { LINEAR_WORK_LIMIT, hostileGlobs, linearWork } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { matchGuarded, type GuardedList } from "./paths.js";

const HOME = "/home/you";

describe("a guarded path pattern that is a hostile glob", () => {
  it.each(hostileGlobs())("grows linearly with the path for %s", (_name, { glob, path, steady }) => {
    const list: GuardedList = { paths: [{ id: "p", pattern: `/${glob}` }], basenames: [] };
    const { ratio } = linearWork((size) => {
      const input = `/${path(size)}`;
      // A fresh list per call misses matchGuarded's answer memo, so each counted run matches the pattern (TP-4255).
      return () => matchGuarded(input, { ...list }, HOME);
    }, { from: 1, to: 1024, steady, meter: linearRegExpSteps });
    expect(ratio).toBeLessThan(LINEAR_WORK_LIMIT);
  });
});
