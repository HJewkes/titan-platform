import { describe, expect, it } from "vitest";
import { FactoryConfigSchema } from "../config.js";

const parsed = (branchPrefixes: unknown) => FactoryConfigSchema.safeParse({ shepherd: { consoleAnswers: { roundsDir: "/srv/rounds", branchPrefixes } } });

describe("shepherd.consoleAnswers.branchPrefixes", () => {
  it("loads prefixes that each end in a slash", () => {
    const result = parsed(["scratch/", "spike/tp/"]);

    expect(result.data?.shepherd?.consoleAnswers?.branchPrefixes).toEqual(["scratch/", "spike/tp/"]);
  });

  // Kills: a prefix rule loose enough that an empty or slashless prefix makes every branch, or a whole name, deletable.
  it.each([[[""]], [["scratch"]], [["/"]], [["refs/heads/../"]], [[]]])("refuses the prefix list %j", (branchPrefixes) => {
    expect(parsed(branchPrefixes).success).toBe(false);
  });
});
