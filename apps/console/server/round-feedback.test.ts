import { describe, expect, it } from "vitest";
import { agrees, buildRoundFeedback, feedbackProblems, isAnswered, normalizeAnswer, unansweredQuestionIds, type PostedRound } from "./round-feedback.js";
import { FeedbackSchema, RoundSchema, type Manifest } from "./round-schema.js";
import type { SubmittedAnswer } from "./round2-adapter.js";

const SHA = "a".repeat(64);
const NOW = new Date("2026-01-02T03:04:05.000Z");

const recommend = (answer: string | string[] | number) => ({ answer, rationale: "Synthetic reason.", confidence: 0.7, by: "fixture-agent" });

const manifest: Manifest = RoundSchema.parse({
  schema: "titan-review/round@2",
  unit: "teapot-glaze",
  round: 2,
  storybookUrl: "http://127.0.0.1:6006",
  widths: [1280],
  variants: [
    { key: "matte", storyId: "teapot--matte", label: "Matte" },
    { key: "gloss", image: "frames/gloss.png", label: "Gloss" },
  ],
  sections: [
    {
      id: "finish",
      title: "Finish",
      deciding: "Which finish the teapot ships with.",
      changed: "Two finishes replace the one glaze.",
      context: "Colour is asked separately.",
      kind: "STATES",
      parts: [{ id: "glaze", label: "Glaze", proposed: 'glaze: "matte"', lang: "ts" }],
      variantKeys: ["matte", "gloss"],
      questionIds: ["finish"],
    },
  ],
  questions: [
    {
      id: "finish",
      kind: "pick-one",
      prompt: "Which finish?",
      options: ["Matte", "Gloss"],
      required: true,
      signsOff: "glaze",
      optionDetails: { Matte: { detail: "Softer light.", after: "The glaze is matte." }, Gloss: { detail: "Brighter light." } },
      recommendation: recommend("Matte"),
    },
    { id: "lid", kind: "pick-one", prompt: "Which lid?", options: ["Domed", "Flat", "Rethink the lid"], revisionOption: "Rethink the lid", signsOff: "glaze", recommendation: recommend("Flat") },
    { id: "colours", kind: "pick-many", prompt: "Which colours?", options: ["Ash", "Rust", "Moss"], recommendation: recommend(["Ash", "Moss"]) },
    { id: "weight", kind: "scale", prompt: "How heavy?", min: 1, max: 5, recommendation: recommend(3) },
    { id: "notes", kind: "text", prompt: "Anything else?" },
  ],
});

const posted = (answers: SubmittedAnswer[], general = ""): PostedRound => ({ answers, general });
const build = (answers: SubmittedAnswer[], partial = false) => buildRoundFeedback(manifest, SHA, posted(answers), NOW, partial);
const answerTo = (answers: SubmittedAnswer[], questionId: string) => build(answers).answers.find((answer) => answer.questionId === questionId);

const COMPLETE: SubmittedAnswer[] = [
  { questionId: "finish", pick: "Matte", comment: "Warmer.", optionNotes: [{ option: "Gloss", note: " Too shiny. " }] },
  { questionId: "lid", pick: "Domed" },
  { questionId: "colours", picks: ["Moss", "Ash"] },
  { questionId: "weight", value: 4 },
  { questionId: "notes", text: "Ship it." },
];

describe("buildRoundFeedback", () => {
  it("builds feedback@1 that the schema accepts and the manifest agrees with", () => {
    const feedback = build(COMPLETE);

    expect(FeedbackSchema.parse(feedback)).toEqual(feedback);
    expect(feedbackProblems(feedback, manifest)).toEqual([]);
    expect(feedback).toMatchObject({ unit: "teapot-glaze", round: 2, manifestSha256: SHA, submittedAt: NOW.toISOString() });
  });

  it("marks an agreeing pick agreed and a differing one not", () => {
    expect(answerTo(COMPLETE, "finish")).toMatchObject({ recommendation: recommend("Matte"), agreed: true });
    expect(answerTo(COMPLETE, "lid")).toMatchObject({ recommendation: recommend("Flat"), agreed: false });
    expect(answerTo(COMPLETE, "weight")).toMatchObject({ agreed: false });
  });

  it("echoes the recommendation on a commented but unanswered question without agreed", () => {
    const answer = answerTo([{ questionId: "weight", comment: "Unsure." }], "weight");

    expect(answer).toEqual({ questionId: "weight", comment: "Unsure.", recommendation: recommend(3) });
  });

  it("leaves out a question the owner did not touch", () => {
    expect(build([{ questionId: "finish", pick: "Gloss" }]).answers.map((answer) => answer.questionId)).toEqual(["finish"]);
  });

  it("compares pick-many agreement as sets", () => {
    expect(answerTo([{ questionId: "colours", picks: ["Moss", "Ash"] }], "colours")).toMatchObject({ agreed: true });
    expect(answerTo([{ questionId: "colours", picks: ["Moss", "Ash", "Rust"] }], "colours")).toMatchObject({ agreed: false });
  });

  it("records the author's revision option as a revision request that disagrees", () => {
    const answer = answerTo([{ questionId: "lid", pick: "Rethink the lid", comment: "Neither fits." }], "lid");

    expect(answer).toMatchObject({ revisionRequested: true, agreed: false });
    expect(answer).not.toHaveProperty("pick");
  });

  it("keeps the built-in revision request only where the question offers it", () => {
    expect(answerTo([{ questionId: "finish", revisionRequested: true, comment: "Try satin." }], "finish")).toMatchObject({ revisionRequested: true, agreed: false });
    expect(answerTo([{ questionId: "lid", revisionRequested: true }], "lid")).toBeUndefined();
  });

  it("echoes the picked option's after and only non-blank notes on real options, trimmed", () => {
    expect(answerTo(COMPLETE, "finish")).toMatchObject({ after: "The glaze is matte.", optionNotes: [{ option: "Gloss", note: "Too shiny." }] });
  });

  it("echoes each frame undecided with its source and the questions its section shows", () => {
    expect(build([]).variants).toEqual([
      { key: "matte", storyId: "teapot--matte", verdict: null, comment: "", annotations: [], relatedQuestionIds: ["finish"] },
      { key: "gloss", image: "frames/gloss.png", verdict: null, comment: "", annotations: [], relatedQuestionIds: ["finish"] },
    ]);
  });

  it("lists exactly the unanswered ids in manifest order on a partial build; a comment alone does not answer", () => {
    const feedback = build([{ questionId: "weight", value: 2 }, { questionId: "finish", comment: "Still deciding." }], true);

    expect(feedback.unansweredQuestionIds).toEqual(["finish", "lid", "colours", "notes"]);
    expect(feedbackProblems(feedback, manifest)).toEqual([]);
  });

  it("lists no unanswered ids on a full build", () => {
    expect(build([], false)).not.toHaveProperty("unansweredQuestionIds");
  });

  it("marks an answered recommended question seen in a shown round", () => {
    const shown = { ...manifest, recommendations: "shown" as const };
    const feedback = buildRoundFeedback(shown, SHA, posted(COMPLETE), NOW);

    expect(feedback.answers.filter((answer) => answer.recommendationSeen).map((answer) => answer.questionId)).toEqual(["finish", "lid", "colours", "weight"]);
  });
});

describe("feedbackProblems", () => {
  it("names a required question left out of a full build", () => {
    expect(feedbackProblems(build([{ questionId: "lid", pick: "Flat" }]), manifest)).toEqual(["finish: required"]);
  });

  it("names unknown options, out-of-range values and a revision request with no comment", () => {
    const feedback = build([
      { questionId: "finish", revisionRequested: true },
      { questionId: "colours", picks: ["Ash", "Teal"] },
      { questionId: "weight", value: 9 },
    ]);

    expect(feedbackProblems(feedback, manifest)).toEqual([
      "finish: a revision request needs a comment",
      "colours: unknown options Teal",
      "weight: value out of range",
    ]);
  });

  it("names an unansweredQuestionIds list that disagrees with the answers", () => {
    const feedback = { ...build(COMPLETE), unansweredQuestionIds: ["notes"] };

    expect(feedbackProblems(feedback, manifest)).toEqual(["unansweredQuestionIds lists notes; unanswered are none"]);
  });

  it("names a pin whose id is not numbered on its own frame", () => {
    const pin = (id: string) => ({ id, width: 375, x: 1, y: 2, xPct: 0.1, yPct: 0.2, note: "Synthetic note." });
    const variants = [{ key: "matte", annotations: [pin("matte-1"), pin("gloss-1"), pin("matte-0")] }];

    const feedback = buildRoundFeedback(manifest, SHA, { ...posted(COMPLETE), variants }, NOW);

    expect(feedbackProblems(feedback, manifest)).toEqual(['matte: pin "gloss-1" is not one of its pins', 'matte: pin "matte-0" is not one of its pins']);
  });
});

describe("answer helpers", () => {
  it("reads a revisionOption pick as answered and normalises it to a request", () => {
    const lid = manifest.questions.find((question) => question.id === "lid");
    if (lid === undefined) throw new Error("the fixture has no lid question");

    expect(isAnswered(lid, { questionId: "lid", pick: "Rethink the lid" })).toBe(true);
    expect(normalizeAnswer(lid, { questionId: "lid", pick: "Rethink the lid" })).toEqual({ questionId: "lid", revisionRequested: true });
  });

  it("counts an answer with a blank text or no picks as unanswered", () => {
    const answers = [
      { questionId: "notes", text: "  " },
      { questionId: "colours", picks: [] },
      { questionId: "lid", pick: "Rethink the lid" },
    ];

    expect(unansweredQuestionIds(manifest, answers)).toEqual(["finish", "colours", "weight", "notes"]);
  });

  it("never agrees with a revision request", () => {
    expect(agrees({ questionId: "finish", revisionRequested: true }, recommend("Matte"))).toBe(false);
  });
});
