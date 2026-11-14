import { describe, expect, it } from "vitest";
import { renderPrompt } from "./core.js";
import { falseAlarmItems, NOT_REAL, parseFaControls, REAL, type FaSource } from "./review-fa.js";

const HEAD = ["export function add(a, b) {", "  return a - b;", "}"];
const source: FaSource = {
  review: (sessionId) => `Verdict: FIX_FIRST. add() subtracts instead of adding (${sessionId === "sess-1" ? "src/math.ts:2" : "?"}).`,
  diff: () => "--- a/src/math.ts\n+++ b/src/math.ts\n-  return a + b;\n+  return a - b;",
  headLines: () => HEAD,
};

const job = (armId: string, model: string, caseId: string, sessionId: string) => ({ arm: { id: armId, model, effort: "high" }, caseId, attempt: 1, sessionId });
const score = (armId: string, caseId: string, caseType: string, falseAlarm: boolean, blocking: object[]) => ({ arm: armId, caseId, attempt: 1, result: { caseType, falseAlarm, verdict: "FIX_FIRST", blocking } });
const cite = { path: "src/math.ts", lineStart: 2, lineEnd: 2 };

describe("falseAlarmItems", () => {
  const jobs = [job("S-high", "claude-sonnet-5-5", "case-1", "sess-1"), job("H-med", "claude-haiku-5-5", "case-2", "sess-2"), job("O-med", "claude-opus-5-5", "case-3", "sess-3")];
  const scores = [score("S-high", "case-1", "clean", true, [cite, { ...cite, lineStart: 1, lineEnd: 3 }]), score("H-med", "case-2", "planted", true, [cite]), score("O-med", "case-3", "clean", false, [])];

  it("makes one item per blocking finding of a false alarm on a clean case", () => {
    const items = falseAlarmItems(scores, jobs, source);
    expect(items.map((entry) => entry.item.key)).toEqual(["S-high:case-1:0", "S-high:case-1:1"]);
    expect(items[0]?.item.questions[0]?.texts["cited-lines"]).toBe("src/math.ts lines 2-2:\n  return a - b;");
  });

  it("judges a Sonnet arm's finding with a model other than Sonnet", () => {
    const [first] = falseAlarmItems(scores, jobs, source);
    expect(first?.judges).toEqual({ judge: { model: "claude-opus-5-5", effort: "medium" }, second: { model: "claude-fable-5-2", effort: "medium" } });
  });

  it("keeps the arm id and model out of the judge prompt", () => {
    const prompts = falseAlarmItems(scores, jobs, source).flatMap((entry) => entry.item.questions.map(renderPrompt));
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) for (const leak of ["S-high", "sonnet", "claude-", "$"]) expect(prompt).not.toContain(leak);
    expect(prompts[0]).toContain("src/math.ts:2-2");
  });

  it("refuses a false alarm whose job row is missing", () => {
    expect(() => falseAlarmItems(scores, jobs.slice(1), source)).toThrow(/no job row for S-high on case-1/);
  });
});

describe("parseFaControls", () => {
  const control = { key: "planted-1", expected: REAL, review: "FIX_FIRST: off by one", path: "src/a.ts", lineStart: 4, lineEnd: 4, citedLines: "for (i = 0; i <= n; i++)", diff: "+for (i = 0; i <= n; i++)" };

  it("turns each control into a single-question item that carries its expected label", () => {
    const parsed = parseFaControls([control, { ...control, key: "fabricated-1", expected: NOT_REAL }]);
    expect(parsed.map((entry) => [entry.key, entry.expected, entry.questions.length])).toEqual([["planted-1", REAL, 1], ["fabricated-1", NOT_REAL, 1]]);
  });

  it("rejects a control whose expected label is not real or not-real", () => {
    expect(() => parseFaControls([{ ...control, expected: "maybe" }])).toThrow();
  });
});
