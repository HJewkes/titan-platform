import { describe, expect, it } from "vitest";
import { classFor, classTable, sizeBand, type ThroughputRow } from "./index.js";

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
    kind: "correctness",
    estimate: 2,
    ...rest,
  };
}

function rows(count: number, overrides: Partial<ThroughputRow> & { hours?: number } = {}, prefix = "T"): ThroughputRow[] {
  return Array.from({ length: count }, (_, i) => row({ taskId: `${prefix}-${i}`, ...overrides }));
}

describe("sizeBand", () => {
  it("bands estimates into <=1, 2, 3, >=4 and none", () => {
    expect([0.5, 1, 2, 3, 4, 9, null, undefined].map(sizeBand)).toEqual(["<=1", "<=1", "2", "3", ">=4", ">=4", "none", "none"]);
  });
});

describe("classTable quantiles", () => {
  it("reports p10, p50, p80 and p90 per metric for a class with enough rows", () => {
    const actuals = Array.from({ length: 20 }, (_, i) => row({ taskId: `T-${i}`, hours: i + 1 }));

    const entry = classTable(actuals, { asOf: AS_OF }).classes["correctness/2"];

    expect(entry?.level).toBe("class");
    expect(entry?.n).toBe(20);
    expect(entry?.implAgentHours).toEqual({ p10: 2, p50: 10, p80: 16, p90: 18 });
    expect(entry?.usd.p50).toBe(20);
    expect(entry?.reviewAgentHours.p90).toBeCloseTo(1.8);
  });

  it("maps a missing kind to untagged and a missing estimate to none", () => {
    const table = classTable(rows(20, { kind: null, estimate: null }), { asOf: AS_OF });

    expect(Object.keys(table.classes)).toEqual(["untagged/none"]);
  });

  it("leaves rows with no implementer session out of the quantiles", () => {
    const actuals = [...rows(20, { hours: 1 }), ...rows(5, { hours: 0, flags: ["no-impl-session"] }, "Z")];

    const table = classTable(actuals, { asOf: AS_OF });

    expect(table.excludedRows).toBe(5);
    expect(table.classes["correctness/2"]?.implAgentHours.p10).toBe(1);
  });
});

describe("classTable back-off", () => {
  it("backs off a thin class to its kind and names the level and n used", () => {
    const actuals = [...rows(3, { estimate: 3 }, "A"), ...rows(20, { estimate: 2 }, "B")];

    const entry = classTable(actuals, { asOf: AS_OF }).classes["correctness/3"];

    expect(entry).toMatchObject({ level: "kind", levelKey: "correctness", n: 23 });
  });

  it("backs off to the size band when the kind is thin too", () => {
    const actuals = [...rows(3, { kind: "docs" }, "A"), ...rows(20, { kind: "security" }, "B")];

    const entry = classTable(actuals, { asOf: AS_OF }).classes["docs/2"];

    expect(entry).toMatchObject({ level: "band", levelKey: "2", n: 23 });
  });

  it("backs off to the task's initiative, then to global", () => {
    const actuals = [
      ...rows(3, { kind: "docs", estimate: 1, initiative: "beta" }, "A"),
      ...rows(19, { kind: "security", estimate: 4, initiative: "beta" }, "B"),
      ...rows(5, { kind: "nit", estimate: null, initiative: "gamma" }, "C"),
    ];
    const table = classTable(actuals, { asOf: AS_OF });

    expect(classFor(table, { kind: "docs", estimate: 1, initiative: "beta" })).toMatchObject({ level: "initiative", levelKey: "beta", n: 22 });
    expect(classFor(table, { kind: "docs", estimate: 1, initiative: "gamma" })).toMatchObject({ level: "global", levelKey: "*", n: 27 });
    expect(table.classes["docs/<=1"]).toMatchObject({ level: "global", n: 27 });
  });

  it("resolves an unseen class through the same back-off", () => {
    const table = classTable(rows(20, { kind: "security" }), { asOf: AS_OF });

    expect(classFor(table, { kind: "feature", estimate: 2, initiative: "alpha" })).toMatchObject({ kind: "feature", band: "2", level: "band" });
  });

  it("honours a configured minimum n", () => {
    const entry = classTable(rows(5), { asOf: AS_OF, minN: 5 }).classes["correctness/2"];

    expect(entry?.level).toBe("class");
  });
});

describe("classTable recency weighting", () => {
  it("weights a row 21 days old at one half", () => {
    const actuals = [...rows(20, { doneAt: AS_OF }, "A"), ...rows(20, { doneAt: "2026-09-10T00:00:00Z" }, "B")];

    const entry = classTable(actuals, { asOf: AS_OF }).classes["correctness/2"];

    expect(entry?.n).toBe(40);
    expect(entry?.weightedN).toBeCloseTo(30);
  });

  it("lets recent rows dominate the quantiles", () => {
    const recent = rows(10, { hours: 1, doneAt: AS_OF }, "A");
    const old = rows(12, { hours: 5, doneAt: "2026-07-01T00:00:00Z" }, "B");

    const entry = classTable([...recent, ...old], { asOf: AS_OF, minN: 1 }).classes["correctness/2"];

    expect(entry?.implAgentHours.p50).toBe(1);
    expect(entry?.implAgentHours.p90).toBe(1);
  });

  it("counts a thin class by weighted rows, so stale rows trigger back-off", () => {
    const actuals = [...rows(25, { estimate: 3, doneAt: "2026-07-01T00:00:00Z" }, "A"), ...rows(20, { estimate: 2 }, "B")];

    const entry = classTable(actuals, { asOf: AS_OF }).classes["correctness/3"];

    expect(entry?.level).toBe("kind");
  });

  it("defaults the reference time to the newest done date", () => {
    const actuals = [...rows(20, { doneAt: "2026-09-30" }, "A"), ...rows(20, { doneAt: "2026-09-09" }, "B")];

    const table = classTable(actuals);

    expect(table.asOf).toBe("2026-09-30T00:00:00.000Z");
    expect(table.classes["correctness/2"]?.weightedN).toBeCloseTo(30);
  });

  it("rejects a row whose done date does not parse", () => {
    expect(() => classTable([row({ doneAt: "yesterday" })])).toThrow(/doneAt/);
  });
});

describe("classTable determinism", () => {
  const actuals = [
    ...Array.from({ length: 30 }, (_, i) => row({ taskId: `A-${i}`, hours: (i * 7) % 11, doneAt: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}` })),
    ...rows(4, { kind: "docs", estimate: 5, initiative: "beta", doneAt: "2026-09-15" }, "B"),
  ];

  it("gives equal output for equal inputs in any row order", () => {
    const config = { asOf: AS_OF, minerIndexedAt: "2026-09-30T12:00:00Z" };

    expect(JSON.stringify(classTable([...actuals].reverse(), config))).toBe(JSON.stringify(classTable(actuals, config)));
  });

  it("carries the watermark, the package version and a model hash", () => {
    const table = classTable(actuals, { asOf: AS_OF, minerIndexedAt: "2026-09-30T12:00:00Z" });

    expect(table.watermark).toEqual({ newestDoneAt: "2026-09-28T00:00:00.000Z", minerIndexedAt: "2026-09-30T12:00:00Z" });
    expect(table.packageVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(table.modelHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes the model hash when the config or the watermark changes", () => {
    const base = classTable(actuals, { asOf: AS_OF }).modelHash;

    expect(classTable(actuals, { asOf: AS_OF, halfLifeDays: 14 }).modelHash).not.toBe(base);
    expect(classTable(actuals, { asOf: AS_OF, minerIndexedAt: "2026-10-01T00:00:00Z" }).modelHash).not.toBe(base);
    expect(classTable(actuals.slice(0, 20), { asOf: AS_OF }).modelHash).not.toBe(base);
  });
});
