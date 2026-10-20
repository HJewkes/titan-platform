import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import type { Feedback, Manifest, Question } from "./round-schema.js";
import { parseManifest } from "./rounds.js";
import { priorFeedback, shipBlockers } from "./ship-blockers.js";

function fixture(id: string): Manifest {
  const parsed = parseManifest(readFileSync(path.join(FIXTURE_ROUNDS.dir, id, "round.json")));
  if (!parsed.ok) throw new Error(`${id} is not a valid round`);
  return parsed.manifest;
}

const SHIP_TILE = fixture("ship-tile-r1");
const atRound = (round: number, manifest = SHIP_TILE): Manifest => ({ ...manifest, round });

function feedback(answers: Feedback["answers"], general = ""): Feedback {
  return { schema: "titan-review/feedback@1", unit: "ship-tile", round: 1, manifestSha256: "0".repeat(64), submittedAt: "2031-03-05T00:00:00.000Z", answers, variants: [], general };
}

function withSide(side: Question, recommendations: Manifest["recommendations"] = "after-answer"): Manifest {
  return { ...SHIP_TILE, recommendations, questions: SHIP_TILE.questions.map((question) => (question.id === "badge-follow-up" ? side : question)) };
}

const NO_DRAFT = { answers: [], general: "", addressed: [] };

describe("priorFeedback", () => {
  it("carries an earlier Don't ship with its note forward, verbatim", () => {
    const earlier = [{ manifest: atRound(1), feedback: feedback([{ questionId: "ship-tiles", pick: "Don't ship", comment: "The stripe is two pixels low." }]) }];

    expect(priorFeedback(atRound(2), earlier)).toEqual([
      { round: 1, submittedAt: "2031-03-05T00:00:00.000Z", pick: "Don't ship", comment: "The stripe is two pixels low." },
    ]);
  });

  it("skips a plain Ship, an unsent round, a later round and another unit", () => {
    const earlier = [
      { manifest: atRound(1), feedback: feedback([{ questionId: "ship-tiles", pick: "Ship" }]) },
      { manifest: atRound(2), feedback: null },
      { manifest: atRound(4), feedback: feedback([], "Later note") },
      { manifest: { ...atRound(1), unit: "other-unit" }, feedback: feedback([], "Not this unit") },
    ];

    expect(priorFeedback(atRound(3), earlier)).toEqual([]);
  });

  it("counts a side comment, a round note and a revision request", () => {
    const earlier = [
      { manifest: atRound(2), feedback: feedback([{ questionId: "ship-tiles", revisionRequested: true }], "Redo the dark tile.") },
      { manifest: atRound(1), feedback: feedback([{ questionId: "badge-follow-up", pick: "Yes", comment: "File it." }, { questionId: "ship-tiles", pick: "Ship" }]) },
    ];

    expect(priorFeedback(atRound(3), earlier)).toMatchObject([
      { round: 1, comment: "File it." },
      { round: 2, revisionRequested: true, general: "Redo the dark tile." },
    ]);
  });
});

describe("shipBlockers", () => {
  const prior = [{ round: 1, submittedAt: "2031-03-05T00:00:00.000Z", pick: "Don't ship" }];

  it("lets a round with no prior feedback and no change request ship", () => {
    expect(shipBlockers(SHIP_TILE, [], { ...NO_DRAFT, answers: [{ questionId: "badge-follow-up", pick: "No" }] })).toEqual([]);
  });

  it("blocks on earlier feedback until its round is ticked Addressed", () => {
    expect(shipBlockers(SHIP_TILE, prior, NO_DRAFT)).toEqual(["your feedback from round 1 is not ticked Addressed"]);
    expect(shipBlockers(SHIP_TILE, prior, { ...NO_DRAFT, addressed: [1] })).toEqual([]);
  });

  it("blocks on a comment or round feedback typed in the draft", () => {
    const draft = { answers: [{ questionId: "badge-follow-up", comment: "Only if design agrees." }], general: "Tighten the stripe.", addressed: [] };

    expect(shipBlockers(SHIP_TILE, [], draft)).toEqual([
      'you left a comment on "File the badge colour as a follow-up?"',
      "you left feedback on this round",
    ]);
  });

  it("ignores blank text", () => {
    expect(shipBlockers(SHIP_TILE, [], { answers: [{ questionId: "badge-follow-up", comment: "  " }], general: " \n", addressed: [] })).toEqual([]);
  });

  it.each([
    ["a pick-one", { id: "badge-follow-up", kind: "pick-one", prompt: "Colour?", options: ["Yes", "No"], implemented: "Yes", signsOff: "badge-colour" }, { pick: "No" }, { pick: "Yes" }],
    ["a pick-many", { id: "badge-follow-up", kind: "pick-many", prompt: "Colour?", options: ["A", "B", "C"], implemented: ["A", "B"] }, { picks: ["A"] }, { picks: ["B", "A"] }],
  ] as const)("blocks %s side pick that differs from the implemented choice", (_label, side, differing, matching) => {
    const manifest = withSide(side as Question);

    expect(shipBlockers(manifest, [], { ...NO_DRAFT, answers: [{ questionId: "badge-follow-up", ...differing }] })).toEqual(['your answer to "Colour?" differs from the implemented choice']);
    expect(shipBlockers(manifest, [], { ...NO_DRAFT, answers: [{ questionId: "badge-follow-up", ...matching }] })).toEqual([]);
  });

  it("measures a pick against a shown recommendation, never against one the page withholds", () => {
    const side = SHIP_TILE.questions.find((question) => question.id === "badge-follow-up") as Question;
    const draft = { ...NO_DRAFT, answers: [{ questionId: "badge-follow-up", pick: "No" }] };

    expect(shipBlockers(withSide(side, "shown"), [], draft)).toHaveLength(1);
    expect(shipBlockers(withSide(side, "after-answer"), [], draft)).toEqual([]);
  });
});
