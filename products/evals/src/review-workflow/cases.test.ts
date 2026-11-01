import { describe, expect, it } from "vitest";
import { caseHash } from "../hash.js";
import { parseSpec } from "../spec/index.js";
import { FAILURE_FIXTURES, SEED_CASES } from "./cases.js";
import { replayExpectedSchema, replayInputSchema } from "./scenario.js";

const ALL = [...SEED_CASES, ...FAILURE_FIXTURES];

describe("the review-workflow cases", () => {
  it("are strict titan.case/v1 specs whose input and expected the replay reads", () => {
    for (const evalCase of ALL) {
      expect(parseSpec(evalCase, "strict")).toEqual(evalCase);
      expect([replayInputSchema.safeParse(evalCase.input).success, replayExpectedSchema.safeParse(evalCase.expected).success]).toEqual([true, true]);
    }
  });

  it("each hash to an identity of their own", () => {
    expect(new Set(ALL.map(caseHash)).size).toBe(ALL.length);
  });

  it("are synthetic and public, so no transcript or private text is committed", () => {
    expect(ALL.map(({ provenance, visibility }) => `${provenance.source}/${visibility}`)).toEqual(ALL.map(() => "synthetic/public"));
  });
});
