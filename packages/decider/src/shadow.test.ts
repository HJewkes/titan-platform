import { describe, expect, it } from "vitest";
import { OPTIONS, v1Row } from "./fixtures.js";
import { LedgerRowSchema, type LedgerRow, type LedgerRowWire, type Prediction } from "./ledger.js";
import { categoryPolicy, parseRoutingPolicy, setCategoryMode } from "./policy.js";
import { applyDemotions, ledgerPredictions, recommendsAuto, score, verdict } from "./shadow.js";

const NOW = new Date("2026-03-31T12:00:00.000Z");
const now = () => NOW;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECOMMENDED = OPTIONS[0] ?? "";
const OTHER = OPTIONS[1] ?? "";
const shadowPolicy = parseRoutingPolicy({});
const autoPolicy = setCategoryMode(shadowPolicy, "tech_design", "auto");

let seq = 0;
function row(overrides: Partial<LedgerRowWire> = {}, daysAgo = 1): LedgerRow {
  seq += 1;
  return LedgerRowSchema.parse(
    v1Row({
      key: `transcript:sess-${seq}:toolu_${seq}`,
      v: 2,
      class: undefined,
      category: "tech_design",
      pick_type: undefined,
      outcome: "accept",
      answered_at: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
      ...overrides,
    }),
  );
}

function predict(answer: string, escalate = false): Prediction {
  return { answer, confidence: escalate ? 0.4 : 0.9, principleIds: ["p-1"], escalate };
}

function withPredictions(pairs: readonly [LedgerRow, Prediction][]) {
  const rows = pairs.map(([r, p]) => ({ ...r, prediction: p }));
  return { rows, predictions: ledgerPredictions(rows) };
}

/** `agreed` agreeing accept rows plus `disagreed` disagreeing ones, all in the window. */
function sampleSet(agreed: number, disagreed: number) {
  const pairs: [LedgerRow, Prediction][] = [
    ...Array.from({ length: agreed }, (): [LedgerRow, Prediction] => [row(), predict(RECOMMENDED)]),
    ...Array.from({ length: disagreed }, (): [LedgerRow, Prediction] => [row(), predict(OTHER)]),
  ];
  return withPredictions(pairs);
}

function scoreOf(set: { rows: LedgerRow[]; predictions: Map<string, Prediction> }, policy = shadowPolicy) {
  const [only] = score(set.predictions, set.rows, { policy, now });
  if (!only) throw new Error("no category scored");
  return only;
}

describe("verdict", () => {
  it("agrees on an exact option match, ignoring the recommended marker", () => {
    expect(verdict(row(), predict("use a queue"))).toBe("agree");
  });

  it("disagrees when the prediction picks another option", () => {
    expect(verdict(row({ outcome: "other", answer: OTHER }), predict(RECOMMENDED))).toBe("disagree");
  });

  it("counts an amend of the predicted option as agreement", () => {
    expect(verdict(row({ outcome: "amend", answer: `${RECOMMENDED}, but weekly` }), predict(RECOMMENDED))).toBe("agree");
  });

  it("counts an amend of another option as disagreement", () => {
    expect(verdict(row({ outcome: "amend", answer: `${RECOMMENDED}, but weekly` }), predict(OTHER))).toBe("disagree");
  });

  it("counts a redirect as agreement only when the decider escalated", () => {
    const redirect = row({ outcome: "redirect", answer: "Ask the widget team first" });

    expect(verdict(redirect, predict(RECOMMENDED, true))).toBe("agree");
    expect(verdict(redirect, predict(RECOMMENDED))).toBe("missed-redirect");
  });

  it("treats an escalation on a listed-option answer as disagreement", () => {
    expect(verdict(row(), predict(RECOMMENDED, true))).toBe("disagree");
  });
});

describe("score", () => {
  it("scores only owner-answered rows with a prediction inside the 30-day window", () => {
    const set = withPredictions([
      [row(), predict(RECOMMENDED)],
      [row({}, 30), predict(RECOMMENDED)],
      [row({}, 31), predict(RECOMMENDED)],
      [row({ answered_by: "decider" }), predict(RECOMMENDED)],
      [row({ outcome: "none" }), predict(RECOMMENDED)],
    ]);
    const rows = [...set.rows, row()];

    expect(scoreOf({ rows, predictions: set.predictions })).toMatchObject({ samples: 2, agreed: 2, agreement: 1 });
  });

  it("reports agreement, missed redirects and the accept baseline per category", () => {
    const set = withPredictions([
      [row(), predict(RECOMMENDED)],
      [row({ outcome: "other", answer: OTHER }), predict(RECOMMENDED)],
      [row({ outcome: "redirect", answer: "Neither" }), predict(OTHER)],
      [row({ outcome: "redirect", answer: "Neither", category: "agent_ops" }), predict(OTHER, true)],
    ]);

    expect(score(set.predictions, set.rows, { policy: shadowPolicy, now })).toMatchObject([
      { category: "agent_ops", samples: 1, agreement: 1, missedRedirects: 0, baseline: 0 },
      { category: "tech_design", samples: 3, agreed: 1, missedRedirects: 1, baseline: 1 / 3 },
    ]);
  });
});

describe("graduation", () => {
  it("does not recommend auto at 19 samples", () => {
    expect(scoreOf(sampleSet(19, 0))).toMatchObject({ samples: 19, recommendAuto: false });
  });

  it("recommends auto at 20 samples and 90% agreement", () => {
    expect(scoreOf(sampleSet(18, 2))).toMatchObject({ samples: 20, agreement: 0.9, recommendAuto: true });
  });

  it("does not recommend auto at 0.899 agreement", () => {
    expect(scoreOf(sampleSet(899, 101))).toMatchObject({ agreement: 0.899, recommendAuto: false });
  });

  it("allows 1 missed redirect but not 2", () => {
    const missed = (): [LedgerRow, Prediction] => [row({ outcome: "redirect", answer: "Neither" }), predict(OTHER)];
    const agreeing = Array.from({ length: 38 }, (): [LedgerRow, Prediction] => [row(), predict(RECOMMENDED)]);

    expect(scoreOf(withPredictions([...agreeing, missed()]))).toMatchObject({ missedRedirects: 1, recommendAuto: true });
    expect(scoreOf(withPredictions([...agreeing, missed(), missed()]))).toMatchObject({
      missedRedirects: 2,
      agreement: 0.95,
      recommendAuto: false,
    });
  });

  it("never recommends auto for a category held off", () => {
    const off = categoryPolicy(setCategoryMode(shadowPolicy, "tech_design", "off"), "tech_design");

    expect(recommendsAuto({ samples: 50, agreement: 1, missedRedirects: 0 }, off)).toBe(false);
  });
});

describe("demotion", () => {
  const overrule = (daysAgo: number) => row({ answered_by: "overrule" }, daysAgo);

  it("demotes an auto category on 2 overrules within 7 days", () => {
    const scores = score(new Map(), [overrule(0), overrule(7)], { policy: autoPolicy, now });

    expect(scores).toMatchObject([{ category: "tech_design", overrules: 2, demote: true }]);
    expect(categoryPolicy(applyDemotions(autoPolicy, scores), "tech_design").mode).toBe("shadow");
  });

  it("does not demote when the second overrule is 8 days old", () => {
    const scores = score(new Map(), [overrule(0), overrule(8)], { policy: autoPolicy, now });

    expect(scores).toMatchObject([{ overrules: 1, demote: false }]);
    expect(categoryPolicy(applyDemotions(autoPolicy, scores), "tech_design").mode).toBe("auto");
  });

  it("leaves a shadow category as it is", () => {
    expect(score(new Map(), [overrule(0), overrule(1)], { policy: shadowPolicy, now })).toMatchObject([
      { overrules: 2, demote: false },
    ]);
  });
});
