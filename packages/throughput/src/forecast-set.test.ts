import { describe, expect, it } from "vitest";
import { classTable, closureFor, closureRates, forecastSet, weekEffects, type SetTask, type ThroughputRow, type WeekEffect } from "./index.js";
import { drawFromQuantiles } from "./quantile-draw.js";

const AS_OF = "2026-10-01T00:00:00Z";

function row(overrides: Partial<ThroughputRow> & { hours?: number } = {}): ThroughputRow {
  const { hours = 1, ...rest } = overrides;
  return {
    taskId: "T-1",
    initiative: "alpha",
    doneAt: AS_OF,
    implAgentHours: { capped: hours },
    reviewAgentHours: { capped: hours / 10 },
    usd: hours * 2,
    kind: "feature",
    estimate: 2,
    ...rest,
  };
}

function rows(count: number, overrides: Partial<ThroughputRow> & { hours?: number } = {}, prefix = "T"): ThroughputRow[] {
  return Array.from({ length: count }, (_, i) => row({ taskId: `${prefix}-${i}`, ...overrides }));
}

const spreadRows = Array.from({ length: 20 }, (_, i) => row({ taskId: `F-${i}`, hours: i + 1 }));

function tasks(count: number, facts: Omit<SetTask, "taskId"> = { kind: "feature", estimate: 2 }, prefix = "S"): SetTask[] {
  return Array.from({ length: count }, (_, i) => ({ taskId: `${prefix}-${i}`, ...facts }));
}

function uniformWeeks(values: number[]): WeekEffect {
  return {
    weeks: values.map((_, i) => `2026-09-${String(7 + i * 7).padStart(2, "0")}`),
    multipliers: { implAgentHours: values, reviewAgentHours: values, usd: values },
  };
}

describe("drawFromQuantiles", () => {
  const q = { p10: 1, p50: 2, p80: 3, p90: 4 };

  it("returns the knots exactly at u = 0.1, 0.5, 0.8 and 0.9", () => {
    expect([0.1, 0.5, 0.8, 0.9].map((u) => drawFromQuantiles(q, u))).toEqual([1, 2, 3, 4]);
  });

  it("continues past p90 with an exponential tail matched to p80 and p90", () => {
    expect(drawFromQuantiles(q, 0.95)).toBeCloseTo(5);
    const far = drawFromQuantiles(q, 0.999);
    expect(Number.isFinite(far) && far > 5).toBe(true);
  });

  it("stays flat at p90 when p80 equals p90", () => {
    expect(drawFromQuantiles({ p10: 1, p50: 2, p80: 4, p90: 4 }, 0.99)).toBe(4);
  });
});

describe("forecastSet determinism", () => {
  const table = classTable(spreadRows, { asOf: AS_OF });
  const set = [...tasks(4), ...tasks(3, { kind: "feature", estimate: 3 }, "R")];

  it("gives identical output for identical input, in any task order", () => {
    const first = forecastSet(set, table, { seed: "1", draws: 500 });

    const again = forecastSet(set, table, { seed: "1", draws: 500 });
    const reversed = forecastSet([...set].reverse(), table, { seed: "1", draws: 500 });

    expect(again).toEqual(first);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(first));
  });

  it("moves the totals when the seed changes", () => {
    const one = forecastSet(set, table, { seed: "1", draws: 500 });
    const two = forecastSet(set, table, { seed: "2", draws: 500 });

    expect(two.totals).not.toEqual(one.totals);
    expect(two.forecastHash).not.toBe(one.forecastHash);
    expect(two.modelHash).toBe(table.modelHash);
  });
});

describe("forecastSet week effect", () => {
  it("widens the interval of a set without moving its median", () => {
    const table = classTable(spreadRows, { asOf: AS_OF });
    const set = tasks(10);

    const independent = forecastSet(set, table, { seed: "w" }).totals.implAgentHours;
    const shared = forecastSet(set, table, { seed: "w", weekEffect: uniformWeeks([0.6, 0.8, 1, 1.2, 1.4]) });

    const width = (q: typeof independent): number => q.p90 - q.p10;
    expect(shared.weekEffect).toBe("on");
    expect(width(shared.totals.implAgentHours)).toBeGreaterThan(1.5 * width(independent));
    expect(Math.abs(shared.totals.implAgentHours.p50 / independent.p50 - 1)).toBeLessThan(0.1);
  });

  it("reports none-available for an empty week list and draws as without one", () => {
    const table = classTable(spreadRows, { asOf: AS_OF });

    const result = forecastSet(tasks(3), table, { seed: "w", draws: 200, weekEffect: uniformWeeks([]) });

    expect(result.weekEffect).toBe("none-available");
    expect(forecastSet(tasks(3), table, { seed: "w", draws: 200 }).weekEffect).toBe("off");
  });
});

describe("closure", () => {
  const actuals = [...spreadRows, ...rows(20, { kind: "docs", hours: 0, flags: ["no-impl-session"] }, "D")];
  const table = classTable(actuals, { asOf: AS_OF });

  it("draws every task of a class that always closes as zero hours and zero USD", () => {
    const result = forecastSet(tasks(3, { kind: "docs", estimate: 2 }), table, { seed: "c", draws: 300, closure: closureRates(actuals, table) });

    const zero = { p10: 0, p50: 0, p80: 0, p90: 0 };
    expect(result.totals).toEqual({ implAgentHours: zero, reviewAgentHours: zero, usd: zero });
    expect(result.tasks[0]).toMatchObject({ closureRate: 1, closureLevel: "class" });
  });

  it("closes a half-closing class about half the time", () => {
    const half = [...spreadRows, ...rows(20, { hours: 0, flags: ["no-impl-session"] }, "Z")];
    const fit = classTable(half, { asOf: AS_OF });

    const result = forecastSet(tasks(1), fit, { seed: "c", closure: closureRates(half, fit) });

    expect(result.tasks[0]?.closureRate).toBe(0.5);
    expect(result.totals.implAgentHours.p10).toBe(0);
    expect(result.totals.implAgentHours.p90).toBeGreaterThan(0);
  });

  it("leaves closureRate null when no closure rates are passed", () => {
    expect(forecastSet(tasks(1), table, { seed: "c", draws: 10 }).tasks[0]).toMatchObject({ closureRate: null, closureLevel: null });
  });

  it("backs a thin class off to its kind's closure rate", () => {
    const mixed = [...rows(3, { kind: "docs", estimate: 3, flags: ["no-impl-session"] }, "A"), ...rows(10, { kind: "docs" }, "B"), ...rows(10, { kind: "docs", flags: ["no-impl-session"] }, "C")];
    const rates = closureRates(mixed, classTable(mixed, { asOf: AS_OF }));

    const found = closureFor(rates, { kind: "docs", estimate: 3 });

    expect(found).toMatchObject({ level: "kind", levelKey: "docs" });
    expect(found.rate).toBeCloseTo(13 / 23);
  });
});

describe("weekEffects", () => {
  it("returns per-week actual / p50 ratios normalised to mean 1, dropping thin weeks", () => {
    const table = classTable(rows(20, { hours: 2 }, "P"), { asOf: AS_OF });
    const actuals = [
      ...rows(8, { hours: 1, firstImplAt: "2026-09-08T10:00:00Z" }, "A"),
      ...rows(8, { hours: 3, firstImplAt: "2026-09-17T10:00:00Z" }, "B"),
      ...rows(3, { hours: 10, firstImplAt: "2026-09-22T10:00:00Z" }, "C"),
    ];

    const effect = weekEffects(actuals, table);

    expect(effect.weeks).toEqual(["2026-09-07", "2026-09-14"]);
    expect(effect.multipliers.implAgentHours).toEqual([0.5, 1.5]);
    expect(effect.multipliers.usd).toEqual([0.5, 1.5]);
  });

  it("normalises a uniformly slow history back to mean 1", () => {
    const table = classTable(rows(20, { hours: 2 }, "P"), { asOf: AS_OF });
    const actuals = [...rows(8, { hours: 4, firstImplAt: "2026-09-08" }, "A"), ...rows(8, { hours: 4, firstImplAt: "2026-09-15" }, "B")];

    expect(weekEffects(actuals, table).multipliers.implAgentHours).toEqual([1, 1]);
  });
});

describe("forecastSet edge cases", () => {
  const table = classTable(rows(20, { kind: "correctness", hours: 2 }), { asOf: AS_OF });

  it("lists an unknown kind as unclassifiable and still draws it at a back-off level", () => {
    const known = tasks(2, { kind: "correctness", estimate: 2 });
    const withUfo = [...known, { taskId: "U-1", kind: "ufo", estimate: 2 }];

    const result = forecastSet(withUfo, table, { seed: "u", draws: 200 });

    expect(result.unclassifiable).toEqual([{ taskId: "U-1", reason: "unknown-kind" }]);
    expect(result.tasks.find((task) => task.taskId === "U-1")).toMatchObject({ kind: "ufo", level: "band", levelKey: "2" });
    expect(result.totals.implAgentHours.p50).toBeGreaterThan(forecastSet(known, table, { seed: "u", draws: 200 }).totals.implAgentHours.p50);
  });

  it("rejects a duplicate taskId and a non-positive draw count", () => {
    expect(() => forecastSet([...tasks(1), ...tasks(1)], table, { seed: 1 })).toThrow(RangeError);
    expect(() => forecastSet(tasks(1), table, { seed: 1, draws: 0 })).toThrow(RangeError);
  });

  it("returns all-zero totals for an empty set", () => {
    const result = forecastSet([], table, { seed: 1, draws: 10 });

    expect(result.totals.usd).toEqual({ p10: 0, p50: 0, p80: 0, p90: 0 });
    expect(result.tasks).toEqual([]);
  });
});
