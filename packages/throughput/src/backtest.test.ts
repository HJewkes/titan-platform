import { describe, expect, it } from "vitest";
import { backtest, type OpenTask, type OriginResult, type ScoredOrigin } from "./backtest.js";
import { classTable } from "./class-table.js";
import type { ThroughputRow } from "./rows.js";

const MS_PER_DAY = 86_400_000;
const START_MS = Date.parse("2026-06-01T00:00:00Z");
const WEEKS = 12;
const ROWS_PER_WEEK = 25;

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SyntheticClass {
  kind: string;
  estimate: number;
  /** Uniform hours [low, high) for a given week. */
  range: (week: number) => [number, number];
  peakContextTokens?: number;
}

// feature/2 is U[1, 5): p10 1.4, p50 3, p90 4.6. docs/<=1 is U[0.2, 1): p10 0.28, p90 0.92.
const FEATURE: SyntheticClass = { kind: "feature", estimate: 2, range: () => [1, 5], peakContextTokens: 200_000 };
const DOCS: SyntheticClass = { kind: "docs", estimate: 1, range: () => [0.2, 1], peakContextTokens: 50_000 };
// Narrow for six weeks, then five times wider: the fitted interval undercovers right after the jump.
const DRIFTING: SyntheticClass = { kind: "security", estimate: 3, range: (week) => (week < 6 ? [2, 3] : [1, 6]) };

const iso = (ms: number): string => new Date(ms).toISOString();
const weekStart = (week: number): string => iso(START_MS + week * 7 * MS_PER_DAY);
const weeklyOrigins = (): string[] => Array.from({ length: WEEKS }, (_, week) => weekStart(week));

function corpus(classes: readonly SyntheticClass[], seed = 7): ThroughputRow[] {
  const random = mulberry32(seed);
  const rows: ThroughputRow[] = [];
  for (let week = 0; week < WEEKS; week++) {
    for (const spec of classes) {
      for (let i = 0; i < ROWS_PER_WEEK; i++) {
        const [low, high] = spec.range(week);
        const firstMs = START_MS + (week * 7 + random() * 7) * MS_PER_DAY;
        rows.push({
          taskId: `${spec.kind}-${week}-${i}`,
          initiative: "synthetic",
          doneAt: iso(firstMs + MS_PER_DAY),
          firstImplAt: iso(firstMs),
          implAgentHours: { capped: low + random() * (high - low) },
          reviewAgentHours: { capped: 0.25 },
          usd: 1,
          kind: spec.kind,
          estimate: spec.estimate,
          peakContextTokens: spec.peakContextTokens ?? null,
        });
      }
    }
  }
  return rows;
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const scored = (origin: OriginResult | undefined): ScoredOrigin => {
  if (origin?.status !== "scored") throw new Error(`expected a scored origin, got ${origin?.status}`);
  return origin;
};

describe("backtest on a stationary synthetic corpus", () => {
  const rows = corpus([FEATURE, DOCS]);
  const result = backtest(rows, { origins: weeklyOrigins() });

  it("fits the known class quantiles", () => {
    const table = classTable(rows.filter((row) => row.doneAt < weekStart(11)), { asOf: weekStart(11) });
    const feature = table.classes["feature/2"]!.implAgentHours;

    expect(feature.p10).toBeCloseTo(1.4, 0);
    expect(feature.p90).toBeCloseTo(4.6, 0);
  });

  it("covers 80% overall and per class: each Wilson interval contains 0.80", () => {
    for (const coverage of [result.pooled.coverage, result.pooled.classes["feature/2"]!.coverage, result.pooled.classes["docs/<=1"]!.coverage]) {
      expect(coverage.rate!.lower).toBeLessThanOrEqual(0.8);
      expect(coverage.rate!.upper).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("skips the first origin, which has nothing to train on", () => {
    expect(result.origins[0]).toMatchObject({ status: "skipped", reason: "no-training-rows", trainN: 0, testN: 2 * ROWS_PER_WEEK });
  });

  it("splits train before the origin and test inside the horizon, with the origin's model hash", () => {
    const origin = scored(result.origins[4]);
    const fit = classTable(rows.filter((row) => row.doneAt < weekStart(4) && row.firstImplAt! < weekStart(4)), { asOf: weekStart(4) });

    expect(origin.testN).toBe(2 * ROWS_PER_WEEK);
    expect(origin.trainN).toBe(fit.levels.global.n);
    expect(origin.modelHash).toBe(fit.modelHash);
  });

  it("scores the three baselines; the global median misses a small class by more", () => {
    const docs = scored(result.origins[6]).classes["docs/<=1"]!;

    expect(docs.pointsTimesRate.n).toBe(ROWS_PER_WEEK);
    expect(docs.unweightedClass.coverage.n).toBe(ROWS_PER_WEEK);
    expect(docs.globalMedian.medianAbsLogError!).toBeGreaterThan(docs.model.medianAbsLogError!);
    expect(docs.model.pinball.p50).not.toBeNull();
  });

  it("ranks estimates against actuals and scores the 150k context line", () => {
    const origin = scored(result.origins[6]);

    expect(origin.overall.spearman!).toBeGreaterThan(0.5);
    expect(origin.contextLine).toMatchObject({ precision: 1, recall: 1, n: 2 * ROWS_PER_WEEK });
  });

  it("gives the same output whatever the row order", () => {
    expect(backtest(shuffled(rows, 99), { origins: shuffled(weeklyOrigins(), 3) })).toEqual(result);
  });
});

describe("backtest calibration", () => {
  it("widens a class whose spread jumped by the factor fitted at the previous origin", () => {
    const result = backtest(corpus([FEATURE, DRIFTING]), { origins: weeklyOrigins() });
    const afterJump = scored(result.origins[7]).classes["security/3"]!;

    expect(scored(result.origins[5]).classes["security/3"]!.conformalFactor).toBe(1);
    expect(afterJump.conformalFactor).toBeGreaterThan(1.5);
    expect(afterJump.widenedCoverage.hits).toBeGreaterThan(afterJump.model.coverage.hits);
  });

  it("reports clean-row coverage without the confounded flags", () => {
    const rows = corpus([FEATURE]).map((row, i) => (i % 5 === 0 ? { ...row, flags: ["reopened"] } : row));
    const origin = scored(backtest(rows, { origins: [weekStart(5)] }).origins[0]);

    expect(origin.clean.n).toBe(origin.testN - 5);
    expect(origin.contextLine).not.toBeNull();
  });
});

describe("backtest censoring and skips", () => {
  const open: OpenTask[] = [
    { taskId: "O-1", initiative: "synthetic", kind: "feature", estimate: 2, firstImplAt: iso(START_MS + 22 * MS_PER_DAY) },
    { taskId: "O-2", initiative: "synthetic", kind: "feature", estimate: 2, firstImplAt: iso(START_MS + 23 * MS_PER_DAY) },
    { taskId: "O-3", initiative: "synthetic", kind: "docs", estimate: 1, firstImplAt: iso(START_MS + 24 * MS_PER_DAY) },
    { taskId: "O-4", initiative: "synthetic", kind: "docs", estimate: 1, firstImplAt: iso(START_MS + 40 * MS_PER_DAY) },
    { taskId: "O-5", initiative: "synthetic", kind: "docs", estimate: 1, firstImplAt: null },
  ];

  it("counts open tasks first dispatched in the horizon per class instead of dropping them", () => {
    const origin = scored(backtest(corpus([FEATURE, DOCS]), { origins: [weekStart(3)], open }).origins[0]);

    expect(origin.censored).toEqual({ open: 3, share: 3 / (3 + 2 * ROWS_PER_WEEK), byClass: { "docs/<=1": 1, "feature/2": 2 } });
    expect(origin.classes["feature/2"]!.open).toBe(2);
  });

  it("counts rows with no firstImplAt and no implementer session, and has no context line without peaks", () => {
    const rows = corpus([DRIFTING]);
    rows[0] = { ...rows[0]!, firstImplAt: null };
    rows[1] = { ...rows[1]!, flags: ["no-impl-session"] };
    const result = backtest(rows, { origins: [weekStart(3)] });

    expect(result).toMatchObject({ missingFirstImplAt: 1, excludedRows: 1 });
    expect(scored(result.origins[0]).contextLine).toBeNull();
  });

  it("rejects a non-positive horizon and an unparseable origin", () => {
    expect(() => backtest([], { origins: [weekStart(1)], horizonDays: 0 })).toThrow(RangeError);
    expect(() => backtest([], { origins: ["not a date"] })).toThrow(RangeError);
  });
});
