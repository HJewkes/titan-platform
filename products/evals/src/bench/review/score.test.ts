import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewCaseBody } from "./cases.js";
import { finalMessage, scoreReview } from "./score.js";

const HEAD = "a".repeat(40);
const block = (verdict: string, head = HEAD): string => `Verdict: ${verdict}\nPR: acme/widgets#7\nHead: ${head}`;

const caseOf = (caseType: ReviewCaseBody["caseType"], gold: ReviewCaseBody["gold"] = []): ReviewCaseBody => ({
  id: `widgets-${caseType}`,
  caseType,
  kind: "feature",
  repo: "acme/widgets",
  pr: 7,
  head: HEAD,
  base: "b".repeat(40),
  split: "dev",
  gold,
});

let bundle: string;

beforeEach(() => {
  bundle = mkdtempSync(join(tmpdir(), "review-score-"));
  mkdirSync(join(bundle, "head", "src"), { recursive: true });
  const body = Array.from({ length: 30 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n");
  writeFileSync(join(bundle, "head", "src", "gold.ts"), body);
  writeFileSync(join(bundle, "head", "src", "other.ts"), body);
});

afterEach(() => rmSync(bundle, { recursive: true, force: true }));

describe("scoreReview on a real-defect case", () => {
  const defect = caseOf("defect", [{ path: "src/gold.ts" }]);

  it("catches a FIX_FIRST whose citation resolves at the head and names the gold path", () => {
    const result = scoreReview(defect, `1. src/gold.ts:12 drops the error.\n\n${block("FIX_FIRST")}`, bundle);
    expect(result).toMatchObject({ verdict: "FIX_FIRST", caught: true, contract: false, falseAlarm: null });
    expect(result.cited).toEqual([{ path: "src/gold.ts", lineStart: 12, lineEnd: 12 }]);
  });

  it("does not catch a FIX_FIRST citing only a path that is not gold", () => {
    const result = scoreReview(defect, `1. src/other.ts:12 drops the error.\n\n${block("FIX_FIRST")}`, bundle);
    expect(result).toMatchObject({ verdict: "FIX_FIRST", caught: false });
    expect(result.cited).toEqual([{ path: "src/other.ts", lineStart: 12, lineEnd: 12 }]);
  });

  it("does not catch a gold-path citation at a line past the end of the file", () => {
    expect(scoreReview(defect, `src/gold.ts:99 is wrong.\n${block("FIX_FIRST")}`, bundle)).toMatchObject({ caught: false, cited: [] });
  });

  it("reads citations written through the bundle's head directory as repo paths", () => {
    const message = `${bundle}/head/src/gold.ts:3 and head/src/gold.ts:4 are wrong.\n${block("FIX_FIRST")}`;
    expect(scoreReview(defect, message, bundle).cited.map((cited) => cited.lineStart)).toEqual([3, 4]);
  });

  it("does not catch a MERGE", () => {
    expect(scoreReview(defect, `src/gold.ts:12 looks fine.\n${block("MERGE")}`, bundle)).toMatchObject({ verdict: "MERGE", caught: false, cited: [] });
  });
});

describe("scoreReview on a planted case", () => {
  const planted = caseOf("planted", [{ path: "src/gold.ts", line: 10 }]);

  it("catches a citation within three lines of the planted line", () => {
    expect(scoreReview(planted, `src/gold.ts:13 inverts the check.\n${block("FIX_FIRST")}`, bundle).caught).toBe(true);
  });

  it("does not catch a citation four lines from the planted line", () => {
    expect(scoreReview(planted, `src/gold.ts:14 inverts the check.\n${block("FIX_FIRST")}`, bundle).caught).toBe(false);
  });
});

describe("scoreReview on a clean case", () => {
  const clean = caseOf("clean");

  it("counts a FIX_FIRST as a false alarm", () => {
    expect(scoreReview(clean, `src/other.ts:2 is wrong.\n${block("FIX_FIRST")}`, bundle)).toMatchObject({ falseAlarm: true, caught: null, contract: false });
  });

  it("counts a MERGE as no false alarm", () => {
    expect(scoreReview(clean, block("MERGE"), bundle)).toMatchObject({ falseAlarm: false, verdict: "MERGE" });
  });

  it("counts a missing block as a contract failure and no false alarm", () => {
    expect(scoreReview(clean, "Looks good to me.", bundle)).toMatchObject({ contract: true, falseAlarm: false, verdict: null });
  });
});

describe("scoreReview contract failures", () => {
  const defect = caseOf("defect", [{ path: "src/gold.ts" }]);

  it("fails the contract when the Head line is missing, and never reads it as a verdict", () => {
    const result = scoreReview(defect, "src/gold.ts:12 is wrong.\nVerdict: FIX_FIRST\nPR: acme/widgets#7", bundle);
    expect(result).toMatchObject({ contract: true, contractReason: "missing_head_line", verdict: null, caught: false });
  });

  it("fails the contract when the block names another head", () => {
    expect(scoreReview(defect, `src/gold.ts:12\n${block("FIX_FIRST", "c".repeat(40))}`, bundle)).toMatchObject({ contract: true, contractReason: "wrong_target", caught: false });
  });

  it("fails the contract when there is no final message at all", () => {
    expect(scoreReview(defect, undefined, bundle)).toMatchObject({ contract: true, contractReason: "no_block" });
  });
});

describe("finalMessage", () => {
  const line = (id: string, content: unknown): string => JSON.stringify({ type: "assistant", message: { id, content } });

  it("joins the text blocks of the last assistant message that says anything", () => {
    const transcript = [
      line("m1", [{ type: "text", text: "first look" }]),
      line("m2", [{ type: "text", text: "findings" }]),
      line("m2", [{ type: "text", text: "Verdict: MERGE" }]),
      line("m3", [{ type: "tool_use", name: "Read" }]),
      "not json",
    ].join("\n");
    expect(finalMessage(transcript)).toBe("findings\nVerdict: MERGE");
  });

  it("returns undefined when no assistant message holds text", () => {
    expect(finalMessage(line("m1", [{ type: "tool_use", name: "Read" }]))).toBeUndefined();
  });
});
