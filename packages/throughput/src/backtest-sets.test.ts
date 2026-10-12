import { seededRandom } from "@titan-design/evidence";
import { describe, expect, it } from "vitest";
import { backtestSets, classTable, forecastSet, type SetMembership, type ThroughputRow } from "./index.js";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const START_MS = Date.parse("2026-06-01T00:00:00Z"); // a Monday

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function row(taskId: string, startMs: number, hours: number, overrides: Partial<ThroughputRow> = {}): ThroughputRow {
  return {
    taskId,
    initiative: "alpha",
    firstImplAt: iso(startMs),
    doneAt: iso(startMs + MS_PER_HOUR),
    implAgentHours: { capped: hours },
    reviewAgentHours: { capped: hours / 10 },
    usd: hours * 2,
    kind: "feature",
    estimate: 2,
    ...overrides,
  };
}

function weeklyOrigins(first: number, last: number): string[] {
  return Array.from({ length: last - first + 1 }, (_, i) => iso(START_MS + (first + i) * 7 * MS_PER_DAY));
}

// Tasks every `spacingHours`, `size` consecutive tasks per parent, hours from `hoursOf`.
function parentHistory(count: number, size: number, spacingHours: number, hoursOf: (i: number, startMs: number) => number) {
  const rows: ThroughputRow[] = [];
  const memberships: Record<string, SetMembership> = {};
  for (let i = 0; i < count; i++) {
    const startMs = START_MS + i * spacingHours * MS_PER_HOUR;
    rows.push(row(`T-${String(i).padStart(4, "0")}`, startMs, hoursOf(i, startMs)));
    memberships[`T-${String(i).padStart(4, "0")}`] = { parents: [`P-${Math.floor(i / size)}`] };
  }
  return { rows, memberships };
}

describe("backtestSets calibration", () => {
  it("covers about 80% of parent sets whose task hours are Exp(1)", () => {
    // Over generator seeds exp-1..4 coverage ran 0.72-0.82 (fitted quantiles carry sampling
    // error the draws do not), so this seed is typical, not tuned; summed p90s would sit near 1.0.
    const random = seededRandom("exp-2");
    const { rows, memberships } = parentHistory(1200, 10, 1.68, () => -Math.log(1 - random()));

    const result = backtestSets(rows, { origins: weeklyOrigins(1, 11), memberships, seed: "cal", draws: 500 });

    const coverage = result.kinds.parent.independent.implAgentHours;
    expect(coverage.n).toBeGreaterThan(90);
    expect(coverage.rate!.lower).toBeLessThanOrEqual(0.8);
    expect(coverage.rate!.upper).toBeGreaterThanOrEqual(0.8);
    expect(coverage.hits / coverage.n).toBeGreaterThanOrEqual(0.7);
    expect(coverage.hits / coverage.n).toBeLessThanOrEqual(0.9);
  });
});

describe("backtestSets seat-week groups", () => {
  it("forecasts a seat's week without closure even when the seat holds a closed task", () => {
    const train = Array.from({ length: 40 }, (_, i) =>
      row(`A-${i}`, START_MS + i * MS_PER_HOUR, i + 1, i % 2 === 0 ? { flags: ["no-impl-session"], firstImplAt: null } : {}),
    );
    const weekMs = START_MS + 7 * MS_PER_DAY;
    const week = [...Array.from({ length: 4 }, (_, i) => row(`B-${i}`, weekMs + i * MS_PER_HOUR, 3)), row("B-closed", weekMs, 0, { flags: ["no-impl-session"], firstImplAt: null })];
    const memberships = Object.fromEntries(week.map((task) => [task.taskId, { seat: "tc" }]));
    const origin = iso(weekMs);

    const result = backtestSets([...train, ...week], { origins: [origin], memberships, seed: "s", draws: 200 });

    const group = result.groups.find((scored) => scored.kind === "seat-week")!;
    const tasks = week.map(({ taskId, kind, estimate, initiative }) => ({ taskId, kind, estimate, initiative }));
    const expected = forecastSet(tasks, classTable(train, { asOf: origin }), { seed: `s:${origin}:${group.key}`, draws: 200 });
    expect(group.size).toBe(5);
    expect(group.actual.implAgentHours).toBe(12);
    expect(group.independent).toEqual(expected.totals);
  });
});

describe("backtestSets leakage", () => {
  it("leaves a row started before the origin but done after it out of that origin's fit", () => {
    const { rows, memberships } = parentHistory(80, 5, 4, (i) => 1 + (i % 7));
    const origin = START_MS + 7 * MS_PER_DAY;
    const lateDone = (hours: number) => row("LATE", origin - MS_PER_HOUR, hours, { doneAt: iso(origin + 30 * MS_PER_DAY) });

    const options = { origins: [iso(origin)], memberships, seed: "leak", draws: 200 };
    const small = backtestSets([...rows, lateDone(1)], options);
    const huge = backtestSets([...rows, lateDone(1000)], options);

    expect(small.groups.length).toBeGreaterThan(0);
    expect(huge.groups).toEqual(small.groups);
  });
});

describe("backtestSets censoring", () => {
  it("counts a parent group with an open member as censored and does not score it", () => {
    const { rows, memberships } = parentHistory(80, 5, 4, (i) => 1 + (i % 7));
    const options = { origins: weeklyOrigins(1, 1), memberships, seed: "c", draws: 200 };
    const baseline = backtestSets(rows, options);
    const openGroup = { "OPEN-1": { parents: ["P-OPEN"] }, "DONE-1": { parents: ["P-OPEN"] } };
    const doneMember = row("DONE-1", START_MS + 7 * MS_PER_DAY + MS_PER_HOUR, 2);

    const result = backtestSets([...rows, doneMember], { ...options, memberships: { ...memberships, ...openGroup }, open: [{ taskId: "OPEN-1" }] });

    expect(result.kinds.parent.censored).toBe(1);
    expect(result.kinds.parent.n).toBe(baseline.kinds.parent.n);
    expect(result.groups.some((group) => group.key === "parent:P-OPEN")).toBe(false);
  });
});

describe("backtestSets determinism", () => {
  const { rows, memberships } = parentHistory(120, 5, 4, (i) => 1 + (i % 5));
  const options = { origins: weeklyOrigins(1, 2), memberships, seed: "d", draws: 200 };

  it("gives identical results for rows in any order", () => {
    const shuffled = [...rows].sort((a, b) => (a.taskId.split("").reverse().join("") < b.taskId.split("").reverse().join("") ? -1 : 1));

    expect(backtestSets(shuffled, options)).toEqual(backtestSets(rows, options));
  });

  it("leaves another group's forecast unchanged when an unrelated group is added", () => {
    const extraStart = START_MS + 7 * MS_PER_DAY + 2 * MS_PER_HOUR;
    const extra = [row("X-1", extraStart, 4), row("X-2", extraStart + MS_PER_HOUR, 5)];
    const extraMemberships = { "X-1": { parents: ["P-X"] }, "X-2": { parents: ["P-X"] } };

    const before = backtestSets(rows, options).groups.find((group) => group.key === "parent:P-10")!;
    const after = backtestSets([...rows, ...extra], { ...options, origins: options.origins.slice(0, 1), memberships: { ...memberships, ...extraMemberships } });

    expect(before.origin).toBe(options.origins[0]);
    expect(after.groups.find((group) => group.key === "parent:P-10")).toEqual(before);
    expect(after.groups.some((group) => group.key === "parent:P-X")).toBe(true);
  });

  it("rejects non-positive draws and minSetSize", () => {
    expect(() => backtestSets(rows, { ...options, draws: 0 })).toThrow(RangeError);
    expect(() => backtestSets(rows, { ...options, minSetSize: 0 })).toThrow(RangeError);
  });
});

describe("backtestSets week effect", () => {
  it("forecasts a wider interval in the week-effect arm when weeks run fast and slow together", () => {
    const { rows, memberships } = parentHistory(300, 10, 4, (i, startMs) => (1 + (i % 3)) * (Math.floor((startMs - START_MS) / (7 * MS_PER_DAY)) % 2 === 0 ? 0.5 : 1.5));

    const result = backtestSets(rows, { origins: weeklyOrigins(4, 4), memberships, seed: "w", draws: 500 });

    const group = result.groups[0]!;
    const width = (q: { p10: number; p90: number }) => q.p90 - q.p10;
    expect(width(group.weekEffect.implAgentHours)).toBeGreaterThan(width(group.independent.implAgentHours) * 1.2);
    expect(result.kinds.parent.weekEffect.implAgentHours.n).toBe(result.kinds.parent.independent.implAgentHours.n);
  });
});
