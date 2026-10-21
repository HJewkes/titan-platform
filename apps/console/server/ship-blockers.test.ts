import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_ROUNDS, twoPrRound } from "./round-fixtures.js";
import type { Feedback, Manifest, Question } from "./round-schema.js";
import { parseManifest } from "./rounds.js";
import { frameScope, priorFeedback, sendBackBlocker, shipBlockers, shipScope } from "./ship-blockers.js";

function fixture(id: string): Manifest {
  const parsed = parseManifest(readFileSync(path.join(FIXTURE_ROUNDS.dir, id, "round.json")));
  if (!parsed.ok) throw new Error(`${id} is not a valid round`);
  return parsed.manifest;
}

const SHIP_TILE = fixture("ship-tile-r1");
const atRound = (round: number, manifest = SHIP_TILE): Manifest => ({ ...manifest, round });

function feedback(answers: Feedback["answers"], general = "", variants: Feedback["variants"] = []): Feedback {
  return { schema: "titan-review/feedback@1", unit: "ship-tile", round: 1, manifestSha256: "0".repeat(64), submittedAt: "2031-03-05T00:00:00.000Z", answers, variants, general };
}

type SentVariant = Feedback["variants"][number];
const PIN = { id: "tile-dark-1", width: 1280, x: 640, y: 40, xPct: 0.5, yPct: 0.1, note: "Stripe overlaps the edge." };
const sentFrame = (key: string, words: Partial<Pick<SentVariant, "verdict" | "comment" | "annotations">>): SentVariant => ({
  key, image: `images/${key}.png`, verdict: null, comment: "", annotations: [], ...words,
});

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

describe("priorFeedback on frames (TP-3773 S6b)", () => {
  it("lists an earlier round whose only feedback is on its frames, each frame as one line", () => {
    const variants = [sentFrame("tile-light", { verdict: "rejected" }), sentFrame("tile-dark", { verdict: "maybe", comment: "Too dark.", annotations: [PIN] }), sentFrame("badge-new", { verdict: "chosen" })];
    const earlier = [{ manifest: atRound(1), feedback: feedback([{ questionId: "ship-tiles", pick: "Ship" }], "", variants) }];

    expect(priorFeedback(atRound(2), earlier)).toEqual([
      { round: 1, submittedAt: "2031-03-05T00:00:00.000Z", frames: ["Tile, light (rejected)", "Tile, dark (maybe): Too dark.; pin 1: Stripe overlaps the edge."] },
    ]);
  });

  it("skips an earlier round whose frames were only Chosen or Maybe with no words", () => {
    const variants = [sentFrame("tile-light", { verdict: "chosen" }), sentFrame("tile-dark", { verdict: "maybe" })];

    expect(priorFeedback(atRound(2), [{ manifest: atRound(1), feedback: feedback([{ questionId: "ship-tiles", pick: "Ship" }], "", variants) }])).toEqual([]);
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

  it.each([
    ["a frame comment", { key: "tile-dark", comment: "Too dark." }],
    ["a pin", { key: "tile-dark", annotations: [PIN] }],
    ["a Rejected verdict", { key: "tile-dark", verdict: "rejected" as const }],
  ])("blocks on %s on this round's frame (TP-3773 S6b)", (_label, variant) => {
    expect(shipBlockers(SHIP_TILE, [], { ...NO_DRAFT, variants: [variant] })).toEqual(['you left feedback on frame "Tile, dark"']);
  });

  it("lets a Chosen or Maybe frame with no comment ship", () => {
    const variants = [{ key: "tile-light", verdict: "chosen" as const }, { key: "tile-dark", verdict: "maybe" as const, comment: "  " }];

    expect(shipBlockers(SHIP_TILE, [], { ...NO_DRAFT, variants })).toEqual([]);
  });

  it("ignores blank text", () => {
    expect(shipBlockers(SHIP_TILE, [], { answers: [{ questionId: "badge-follow-up", comment: "  " }], general: " \n", addressed: [] })).toEqual([]);
  });

  const sideCases: [string, Question, { pick?: string; picks?: string[] }, { pick?: string; picks?: string[] }][] = [
    ["a pick-one", { id: "badge-follow-up", kind: "pick-one", prompt: "Colour?", options: ["Yes", "No"], implemented: "Yes", signsOff: "badge-colour" }, { pick: "No" }, { pick: "Yes" }],
    ["a pick-many", { id: "badge-follow-up", kind: "pick-many", prompt: "Colour?", options: ["A", "B", "C"], implemented: ["A", "B"] }, { picks: ["A"] }, { picks: ["B", "A"] }],
  ];

  it.each(sideCases)("blocks %s side pick that differs from the implemented choice", (_label, side, differing, matching) => {
    const manifest = withSide(side);

    expect(shipBlockers(manifest, [], { ...NO_DRAFT, answers: [{ questionId: "badge-follow-up", ...differing }] })).toEqual(['your answer to "Colour?" differs from the implemented choice']);
    expect(shipBlockers(manifest, [], { ...NO_DRAFT, answers: [{ questionId: "badge-follow-up", ...matching }] })).toEqual([]);
  });

  it("measures a pick against a shown recommendation, never against one the page withholds", () => {
    const side = SHIP_TILE.questions.find((question) => question.id === "badge-follow-up");
    if (side === undefined) throw new Error("the Ship fixture has no badge-follow-up question");
    const draft = { ...NO_DRAFT, answers: [{ questionId: "badge-follow-up", pick: "No" }] };

    expect(shipBlockers(withSide(side, "shown"), [], draft)).toHaveLength(1);
    expect(shipBlockers(withSide(side, "after-answer"), [], draft)).toEqual([]);
  });
});

describe("shipScope (TP-3329)", () => {
  const twoPr = (() => {
    const parsed = parseManifest(Buffer.from(JSON.stringify(twoPrRound())));
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.manifest;
  })();

  it("gives each Ship question its own PR group's questions, never the other PR's", () => {
    expect([...shipScope(twoPr, "ship-tiles")].sort()).toEqual(["ship-tiles", "stripe-colour"]);
    expect([...shipScope(twoPr, "ship-panels")]).toEqual(["ship-panels"]);
  });

  it("scopes nothing in a round with one Ship question", () => {
    expect([...shipScope(SHIP_TILE, "ship-tiles")].sort()).toEqual(["badge-follow-up", "ship-tiles"]);
  });

  it("lets another PR's Send back note leave this PR's Ship open", () => {
    const draft = { ...NO_DRAFT, answers: [{ questionId: "ship-tiles", pick: "Don't ship", comment: "Lower the stripe." }] };

    expect(shipBlockers(twoPr, [], draft, "ship-panels")).toEqual([]);
    expect(shipBlockers(twoPr, [], draft, "ship-tiles")).toEqual(['you left a comment on "Ship example/tiles#1 at 89abcdef0123?"']);
  });
});

describe("frameScope (TP-3773 S6b)", () => {
  const twoPr = (() => {
    const parsed = parseManifest(Buffer.from(JSON.stringify(twoPrRound())));
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.manifest;
  })();

  it("gives each Ship question its own PR's frames, and a round with one PR every frame", () => {
    expect([...frameScope(twoPr, "ship-tiles")]).toEqual(["tile-light", "tile-dark"]);
    expect([...frameScope(twoPr, "ship-panels")]).toEqual(["panel-wide", "badge-new"]);
    expect([...frameScope(SHIP_TILE, "ship-tiles")]).toEqual(["tile-light", "tile-dark", "badge-new", "panel-wide"]);
  });

  it("lets another PR's frame feedback leave this PR's Ship open", () => {
    const draft = { ...NO_DRAFT, variants: [{ key: "panel-wide", verdict: "rejected" as const }] };

    expect(shipBlockers(twoPr, [], draft, "ship-tiles")).toEqual([]);
    expect(shipBlockers(twoPr, [], draft, "ship-panels")).toEqual(['you left feedback on frame "Panel, wider"']);
  });
});

describe("sendBackBlocker (decision 513)", () => {
  const backPanels = { questionId: "ship-panels", pick: "Don't ship" };

  it.each([
    ["the PR's own Ship comment", [{ ...backPanels, comment: "Narrow it again." }], ""],
    ["a round note", [backPanels], "Both need another pass."],
  ])("lets a PR go back on %s", (_label, answers, general) => {
    expect(sendBackBlocker({ answers, general }, "ship-panels")).toBeUndefined();
  });

  it.each([
    ["a frame comment", { key: "panel-wide", comment: "Narrower." }],
    ["a pin", { key: "panel-wide", annotations: [{ ...PIN, id: "panel-wide-1" }] }],
  ])("lets a PR go back on %s alone, as the fixer gets it", (_label, variant) => {
    expect(sendBackBlocker({ answers: [backPanels], general: "", variants: [variant] }, "ship-panels")).toBeUndefined();
  });

  it("holds Send back on a verdict with no words, which the fixer never gets", () => {
    expect(sendBackBlocker({ answers: [backPanels], general: "", variants: [{ key: "panel-wide", verdict: "rejected" }] }, "ship-panels")).toBeDefined();
  });

  it("holds a PR's Send back when only another PR's Ship question carries a comment", () => {
    const answers = [{ questionId: "ship-tiles", pick: "Don't ship", comment: "Lower the stripe." }, backPanels];

    expect(sendBackBlocker({ answers, general: " " }, "ship-panels")).toBe("Send back needs a note: say what to fix in the Ship comment or the round note.");
  });
});
