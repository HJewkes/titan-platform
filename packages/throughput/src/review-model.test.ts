import { describe, expect, it } from "vitest";
import { reviewFeatureKey, reviewFor, reviewTable, reviewTarget } from "./review-model.js";
import { type ThroughputRow } from "./rows.js";

let seq = 0;
function row(overrides: Partial<ThroughputRow> = {}): ThroughputRow {
  seq += 1;
  return {
    taskId: `T-${String(seq).padStart(4, "0")}`,
    initiative: "web",
    doneAt: "2026-10-01",
    implAgentHours: { capped: 1 },
    reviewAgentHours: { capped: 1 },
    usd: 1,
    kind: "feature",
    estimate: 2,
    prClass: "standard",
    touches: [],
    changedLines: 50,
    ...overrides,
  };
}

const times = (n: number, make: (i: number) => ThroughputRow) => Array.from({ length: n }, (_, i) => make(i));

describe("reviewFeatureKey", () => {
  it("keys on class and lead touch, gives nopr to a task with no PR, and skips rows with no features", () => {
    expect(reviewFeatureKey({ prClass: "g10", touches: ["migration", "large"] })).toBe("g10/migration");
    expect(reviewFeatureKey({ prClass: "standard", touches: [] })).toBe("standard/none");
    expect(reviewFeatureKey({ prClass: null, touches: [] })).toBe("nopr");
    expect(reviewFeatureKey({ prClass: null, touches: null })).toBeUndefined();
    expect(reviewFeatureKey({})).toBeUndefined();
  });
});

describe("reviewTable with the diff key", () => {
  const corpus = [
    ...times(30, () => row({ prClass: "g10", touches: ["large"], reviewAgentHours: { capped: 2 } })),
    ...times(30, () => row({ prClass: "standard", touches: [], reviewAgentHours: { capped: 0.2 } })),
    ...times(3, () => row({ prClass: "g10", touches: ["migration"], reviewAgentHours: { capped: 2 } })),
  ];

  it("predicts reviewer hours per review class and lead touch", () => {
    const table = reviewTable(corpus, { key: "diff" });

    expect(reviewFor(table, { prClass: "g10", touches: ["large"] }, "reviewAgentHours")).toMatchObject({ level: "key", levelKey: "g10/large", n: 30 });
    expect(reviewFor(table, { prClass: "g10", touches: ["large"] }, "reviewAgentHours")?.quantiles.p50).toBe(2);
    expect(reviewFor(table, { prClass: "standard", touches: [] }, "reviewAgentHours")?.quantiles.p50).toBe(0.2);
  });

  it("backs a thin key off to its review class before global", () => {
    const table = reviewTable(corpus, { key: "diff" });

    const entry = reviewFor(table, { prClass: "g10", touches: ["migration", "untested"] }, "reviewAgentHours");

    expect(entry).toMatchObject({ level: "group", levelKey: "g10", n: 33 });
    expect(entry?.quantiles.p50).toBe(2);
  });

  it("counts rows the diff key cannot place and gives them no prediction", () => {
    const table = reviewTable([...corpus, row({ prClass: null, touches: null })], { key: "diff" });

    expect(table.skippedMissingFeatures).toBe(1);
    expect(reviewFor(table, { prClass: null, touches: null }, "reviewAgentHours")).toBeUndefined();
  });

  it("hashes the key into the model", () => {
    expect(reviewTable(corpus, { key: "diff" }).modelHash).not.toBe(reviewTable(corpus, { key: "base" }).modelHash);
  });
});

describe("reviewTable with the base key", () => {
  it("keys on kind x size band and backs off to the kind", () => {
    const corpus = [...times(25, () => row({ kind: "docs", estimate: 1, reviewAgentHours: { capped: 0.1 } })), row({ kind: "docs", estimate: 4 })];
    const table = reviewTable(corpus, { key: "base" });

    expect(reviewFor(table, { kind: "docs", estimate: 1 }, "reviewAgentHours")).toMatchObject({ level: "key", levelKey: "docs/<=1" });
    expect(reviewFor(table, { kind: "docs", estimate: 5 }, "reviewAgentHours")).toMatchObject({ level: "group", levelKey: "docs" });
  });
});

describe("post-PR wall hours", () => {
  it("sums only the stages after the PR is up, leaving queued out", () => {
    const stageMinutes = { queued: 600, ci: 30, review: 60, "re-review": 30, hold: 0, land: 0 };

    expect(reviewTarget(row({ stageMinutes }), "postPrWallHours")).toBe(2);
  });

  it("skips and counts a row with no Shepherd stages for that target only", () => {
    const corpus = [row({ stageMinutes: { ci: 60 }, reviewRounds: 2 }), row({ stageMinutes: null, reviewRounds: null })];

    const table = reviewTable(corpus, { key: "diff" });

    expect(table.targets.postPrWallHours).toMatchObject({ n: 1, skippedNull: 1 });
    expect(table.targets.reviewRounds).toMatchObject({ n: 1, skippedNull: 1 });
    expect(table.targets.reviewAgentHours).toMatchObject({ n: 2, skippedNull: 0 });
  });
});
