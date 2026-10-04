import { describe, expect, it } from "vitest";
import { snapshotBrief } from "./gate-brief.js";
import { GateBriefInvalid, type GateQuestion, type GateQuestionOption } from "./types.js";

const EVIDENCE = "https://example.test/pr/1/checks";
const SUMMARY = "Merge example#1 at abc1234? CI green. Recommend merge.";

function options(count: number): GateQuestionOption[] {
  return Array.from({ length: count }, (_, index) => ({ id: `o${index}`, label: `Option ${index}` }));
}

function question(id: string, optionList: GateQuestionOption[] = options(2)): GateQuestion {
  return { id, question: `Pick for ${id}?`, options: optionList };
}

function questions(count: number): GateQuestion[] {
  return Array.from({ length: count }, (_, index) => question(`q${index}`));
}

function issuesOf(act: () => unknown): string[] {
  try {
    act();
  } catch (error) {
    if (error instanceof GateBriefInvalid) return error.issues;
    throw error;
  }
  throw new Error("expected GateBriefInvalid");
}

describe("snapshotBrief", () => {
  it("a gate store that requires a brief refuses a gate with no summary", () => {
    const input = { evidenceRef: EVIDENCE };

    const issues = issuesOf(() => snapshotBrief("g1", input, true));

    expect(issues).toEqual(["summary is required"]);
  });

  it("a blank or whitespace evidenceRef is refused", () => {
    const blank = { summary: SUMMARY, evidenceRef: "" };
    const spaces = { summary: SUMMARY, evidenceRef: "   " };

    const blankIssues = issuesOf(() => snapshotBrief("g1", blank, false));
    const spaceIssues = issuesOf(() => snapshotBrief("g1", spaces, false));

    expect(blankIssues).toEqual(["evidenceRef is blank"]);
    expect(spaceIssues).toEqual(["evidenceRef is blank"]);
  });

  it("a summary with a newline is refused", () => {
    const input = { summary: "Merge it?\nRecommend merge.", evidenceRef: EVIDENCE };

    const issues = issuesOf(() => snapshotBrief("g1", input, true));

    expect(issues).toEqual(["summary must be one line with no control characters"]);
  });

  it("five questions are refused; one and four are accepted", () => {
    const brief = { summary: SUMMARY, evidenceRef: EVIDENCE };

    const five = issuesOf(() => snapshotBrief("g1", { ...brief, questions: questions(5) }, true));
    const one = snapshotBrief("g1", { ...brief, questions: questions(1) }, true);
    const four = snapshotBrief("g1", { ...brief, questions: questions(4) }, true);

    expect(five).toEqual(["ask 1 to 4 questions (got 5)"]);
    expect(one.questions).toHaveLength(1);
    expect(four.questions).toHaveLength(4);
  });

  it("a question with one option or five options is refused", () => {
    const single = { questions: [question("q", options(1))] };
    const five = { questions: [question("q", options(5))] };

    const singleIssues = issuesOf(() => snapshotBrief("g1", single, false));
    const fiveIssues = issuesOf(() => snapshotBrief("g1", five, false));

    expect(singleIssues).toEqual(["question 1: give 2 to 4 options"]);
    expect(fiveIssues).toEqual(["question 1: give 2 to 4 options"]);
  });

  it("two recommended options in one question are refused; one recommended in each of two questions is accepted", () => {
    const both: GateQuestionOption[] = [
      { id: "merge", label: "Merge", recommended: true },
      { id: "hold", label: "Hold", recommended: true },
    ];
    const oneEach = [
      question("land", [{ id: "merge", label: "Merge", recommended: true }, { id: "hold", label: "Hold" }]),
      question("notify", [{ id: "yes", label: "Yes" }, { id: "no", label: "No", recommended: true }]),
    ];

    const refused = issuesOf(() => snapshotBrief("g1", { questions: [question("land", both)] }, false));
    const accepted = snapshotBrief("g1", { questions: oneEach }, false);

    expect(refused).toEqual(["question 1: mark at most one option as recommended"]);
    expect(accepted.questions).toEqual(oneEach);
  });

  it("duplicate option ids are refused", () => {
    const duplicated = [question("q", [{ id: "same", label: "A" }, { id: "same", label: "B" }])];

    const issues = issuesOf(() => snapshotBrief("g1", { questions: duplicated }, false));

    expect(issues).toEqual(['question 1: option 2: duplicate option id "same"']);
  });

  it("an option label of 76 characters is refused", () => {
    const long = [question("q", [{ id: "a", label: "x".repeat(76) }, { id: "b", label: "x".repeat(75) }])];

    const issues = issuesOf(() => snapshotBrief("g1", { questions: long }, false));

    expect(issues).toEqual(["question 1: option 1: label is over 75 characters"]);
  });

  it("names every missing field at once when the brief is required", () => {
    const issues = issuesOf(() => snapshotBrief("g1", {}, true));

    expect(issues).toEqual(["summary is required", "evidenceRef is required"]);
  });

  it("returns only the declared question fields", () => {
    const extra = { id: "q", question: "Pick?", note: "dropped", options: [{ id: "a", label: "A", recommended: false, x: 1 }, { id: "b", label: "B" }] };

    const snapshot = snapshotBrief("g1", { questions: [extra] }, false);

    expect(snapshot.questions).toEqual([{ id: "q", question: "Pick?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }]);
  });
});
