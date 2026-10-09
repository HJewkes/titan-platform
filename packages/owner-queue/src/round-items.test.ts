import { FEEDBACK_SCHEMA_ID, MANIFEST_SCHEMA_ID, type ManifestInput } from "@titan-design/review-schema";
import { describe, expect, it } from "vitest";
import { roundAskKey } from "./keys.js";
import { answeredFromFeedback, fromRoundQuestions, ROUND_ANSWERER, type FeedbackInput } from "./round-items.js";
import { buildOwnerRounds } from "./rounds.js";
import { item, SHA_A } from "./test-fixtures.js";

const OPENED = "2026-01-02T03:04:05Z";
const SUBMITTED = "2026-01-03T00:00:00Z";
const recommendation = { answer: "Solid", rationale: "Matches the other alerts", confidence: 0.7, by: "designer" };

function designRound(overrides: Partial<ManifestInput> = {}): ManifestInput {
  return {
    schema: MANIFEST_SCHEMA_ID,
    unit: "alert",
    round: 3,
    storybookUrl: "http://127.0.0.1:6006",
    context: "Round-wide context",
    widths: [1280],
    variants: [],
    questions: [
      { id: "fill", kind: "pick-one", prompt: "Alert fill:\n solid or tinted?", options: ["Solid", "Tinted"], recommendation },
      { id: "notes", kind: "text", prompt: "Anything else?" },
      {
        id: "ship",
        kind: "pick-one",
        prompt: "Ship the alert at this head?",
        options: ["Ship", "Don't ship"],
        required: true,
        page: "example/ui#42",
        merge: { repo: "example/ui", pr: 42, headSha: SHA_A, ship: ["Ship"] },
      },
    ],
    sections: [{ id: "s-fill", title: "Fill", deciding: "The alert fill", context: "Tinted reads softer", questionIds: ["fill"] }],
    ...overrides,
  };
}

function feedback(answers: FeedbackInput["answers"], overrides: Partial<FeedbackInput> = {}): FeedbackInput {
  return {
    schema: FEEDBACK_SCHEMA_ID,
    unit: "alert",
    round: 3,
    manifestSha256: "0".repeat(64),
    submittedAt: SUBMITTED,
    answers,
    variants: [],
    general: "",
    ...overrides,
  };
}

describe("fromRoundQuestions", () => {
  it("opens one item per question with its ask key, section context and recommendation", () => {
    const [fill, notes] = fromRoundQuestions(designRound(), "alert-r3", { openedAt: OPENED });

    expect(fill).toMatchObject({
      id: "round:alert-r3/fill",
      sources: [{ system: "round", ref: "alert-r3#fill" }],
      kind: "review",
      summary: "Alert fill: solid or tinted?",
      context: "The alert fill\nTinted reads softer",
      options: [
        { id: "Solid", label: "Solid" },
        { id: "Tinted", label: "Tinted" },
      ],
      recommended: { optionId: "Solid", by: "designer", confidence: 0.7, rationale: "Matches the other alerts" },
      keys: [roundAskKey("alert", "fill")],
      lens: "planning",
      openedAt: OPENED,
      status: "open",
    });
    expect(notes).toMatchObject({ id: "round:alert-r3/notes", context: "Round-wide context" });
    expect(notes!.options).toBeUndefined();
  });

  it("makes a merge-bound question an approval pinned to the PR head", () => {
    const ship = fromRoundQuestions(designRound(), "alert-r3", { openedAt: OPENED })[2];

    expect(ship).toMatchObject({ kind: "approve", lens: "blocking-merge", keys: [roundAskKey("alert", "ship"), `pr:example/ui#42@${SHA_A}`] });
  });

  it("hides the recommendation of an after-answer round", () => {
    const [fill] = fromRoundQuestions(designRound({ recommendations: "after-answer" }), "alert-r3", { openedAt: OPENED });

    expect(fill!.recommended?.hidden).toBe(true);
  });

  it("cuts a long prompt to one summary line", () => {
    const prompt = `${"word ".repeat(80)}\nend`;
    const round = designRound({ questions: [{ id: "long", kind: "text", prompt }], sections: undefined });

    const [long] = fromRoundQuestions(round, "r", { openedAt: OPENED });

    expect(long!.summary).toHaveLength(280);
    expect(long!.summary).not.toContain("\n");
  });

  it("refuses an invalid manifest or open time", () => {
    expect(() => fromRoundQuestions({ ...designRound(), storybookUrl: "not a url" }, "r", { openedAt: OPENED })).toThrow();
    expect(() => fromRoundQuestions(designRound(), "r", { openedAt: "yesterday" })).toThrow();
  });
});

describe("answeredFromFeedback", () => {
  const context = { roundId: "alert-r3", openedAt: OPENED };

  it("answers each question the owner answered, at the submit time", () => {
    const answers = feedback(
      [
        { questionId: "fill", pick: "Tinted", comment: "softer is right" },
        { questionId: "notes", text: "Check dark mode" },
        { questionId: "ship" },
      ],
      { unansweredQuestionIds: ["ship"] },
    );

    const answered = answeredFromFeedback(answers, designRound(), context);

    expect(answered.map((each) => [each.id, each.status, each.answer])).toEqual([
      ["round:alert-r3/fill", "answered", { optionId: "Tinted", text: "softer is right", by: ROUND_ANSWERER, at: SUBMITTED }],
      ["round:alert-r3/notes", "answered", { text: "Check dark mode", by: ROUND_ANSWERER, at: SUBMITTED }],
    ]);
  });

  it("keeps a pick the question does not offer as text", () => {
    const [fill] = answeredFromFeedback(feedback([{ questionId: "fill", pick: "Outline" }]), designRound(), context);

    expect(fill!.answer).toEqual({ text: "Outline", by: ROUND_ANSWERER, at: SUBMITTED });
  });

  it("refuses feedback for another round", () => {
    expect(() => answeredFromFeedback(feedback([], { round: 4 }), designRound(), context)).toThrow(/alert round 4.*alert round 3/);
  });
});

describe("a round built from owner items", () => {
  const options = [
    { id: "flat", label: "Flat" },
    { id: "nested", label: "Nested" },
  ];
  const items = [
    item({ id: "cache-layout", options, summary: "Pick a cache layout" }),
    item({ id: "naming-a", options, summary: "Name module a" }),
    item({ id: "naming-b", options, summary: "Name module b" }),
  ];
  const principles = [{ id: "one-style", rule: "Use one naming style everywhere.", covers: ["naming-a", "naming-b"] }];

  it("maps its answers back to the items and option ids it asked", () => {
    const { rounds } = buildOwnerRounds(items, { unit: "decisions", storybookUrl: "http://127.0.0.1:6006", principles });
    const { manifest, bindings } = rounds[0]!;
    const [layout, principle] = manifest.questions as { id: string; options: string[] }[];
    const answers = feedback(
      [
        { questionId: layout!.id, pick: layout!.options[1]! },
        { questionId: principle!.id, pick: principle!.options[0]! },
      ],
      { unit: "decisions", round: 1 },
    );

    const answered = answeredFromFeedback(answers, manifest, { roundId: "decisions-r1", openedAt: OPENED, bindings });

    expect(answered.map((each) => [each.id, each.kind, each.answer?.optionId])).toEqual([
      ["cache-layout", "decide", "nested"],
      [`round:decisions-r1/${principle!.id}`, "decide", "yes"],
    ]);
    expect(answered[0]!.options!.map((each) => each.id)).toEqual(["flat", "nested"]);
  });
});
