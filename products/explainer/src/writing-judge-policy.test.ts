import { describe, expect, it } from "vitest";
import type { JudgeHarness } from "./eval-harness.js";
import { runWritingJudge } from "./writing-judge.js";
import { beatsOf, CANARY_LINE, CONFIG, fakeHarness, judgedRow as row, mark, RUBRICS, term, termName, termQuotes } from "./writing-judge-fixtures.test-helpers.js";

// Reads doctrine/writing-gate.json as shipped: these tests pin the calibrated lines, so moving one is a reviewed change.
const shipped = (beats: { id: string; spoken: string }[], harness: () => JudgeHarness) => runWritingJudge({ beats, config: CONFIG, harnessFor: harness, rubrics: RUBRICS });

describe("the shipped judged policy", () => {
  it("warns at 25 marked passages per 1,000 words and errors at 30", async () => {
    const warning = await shipped(beatsOf(20, 5), fakeHarness([mark(CANARY_LINE), ...termQuotes(5)]));
    const error = await shipped(beatsOf(20, 6), fakeHarness([mark(CANARY_LINE), ...termQuotes(6)]));

    expect(row(warning, "writing:hallmark-marks")).toMatchObject({ value: 25, severity: "warning", pass: false });
    expect(row(error, "writing:hallmark-marks")).toMatchObject({ value: 30, severity: "error", pass: false });
  });

  it("passes 20 marked passages per 1,000 words, the warning line itself", async () => {
    const result = await shipped(beatsOf(20, 4), fakeHarness([mark(CANARY_LINE), ...termQuotes(4)]));

    expect(row(result, "writing:hallmark-marks")).toMatchObject({ value: 20, pass: true });
  });

  it("only warns on words per term under the floor, so the row never fails the verdict alone", async () => {
    const result = await shipped(beatsOf(120, 25), fakeHarness([mark(CANARY_LINE)], Array.from({ length: 25 }, (_, i) => term(termName(i)))));

    expect(row(result, "writing:words-per-term")).toMatchObject({ value: 48, severity: "warning", pass: false });
  });
});
