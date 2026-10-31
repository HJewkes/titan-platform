import { lineSourceFromTexts } from "@titan-design/evidence";
import type { ReviewOutcome } from "@titan-design/review-workflow";
import { describe, expect, it } from "vitest";
import { scoreReplay } from "./score.js";

const PATH = "products/factory/src/required-checks-policy.ts";
const HEAD = "1d9e6287f37eddc08c43936627975598290e7439";
const source = lineSourceFromTexts({ [PATH]: "one\ntwo\nthree\nfour\n", "products/factory/src/other.ts": "one\ntwo\n" });
const tp747 = { outcome: "FIX_FIRST", verdict: "block", path: PATH } as const;

const fixFirst = (finding: string): ReviewOutcome => ({
  kind: "FIX_FIRST",
  head: HEAD,
  verdict: { outcome: "FIX_FIRST", head: HEAD, findings: [{ shape: "correctness", text: finding, blocking: true }], dissent: ["correctness"], degraded: [], satisfiesG10: false },
});

describe("scoreReplay on tp#747", () => {
  it("scores a hit when a FIX_FIRST cites the case's path at lines the head has", () => {
    expect(scoreReplay(tp747, fixFirst(`Empty contexts read as valid at ${PATH}:3-4.`), source, 2).hit).toBe(true);
  });

  it("scores no hit when the only verified citation names another path", () => {
    expect(scoreReplay(tp747, fixFirst("The reader is wrong at products/factory/src/other.ts:2."), source, 2)).toMatchObject({ hit: false, matched: false });
  });

  it("scores no hit when the case's path is cited past the end of the file", () => {
    expect(scoreReplay(tp747, fixFirst(`Empty contexts read as valid at ${PATH}:40.`), source, 2)).toMatchObject({ hit: false, matched: false });
  });

  it("counts a hit on a case expected to pass as a false catch", () => {
    const pass = { ...tp747, verdict: "pass" } as const;

    expect(scoreReplay(pass, fixFirst(`Wrong at ${PATH}:1.`), source, 2)).toMatchObject({ hit: true, falseCatch: true, matched: false });
  });
});
