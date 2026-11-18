import type { ClassLabel, TaskRow } from "@titan-design/session-analytics";
import { describe, expect, it } from "vitest";
import { renderReport, reproduce } from "./reproduce.js";
import { e1ExpectedFile, parseExpected, type ExpectedFile } from "./reproduce-spec.js";

/** Synthetic rows: every name and number is made up. W45 runs 11-02 to 11-08, W46 from 11-09. */
function row(taskId: string, fields: Partial<TaskRow> = {}): TaskRow {
  return {
    initiative: "alpha",
    taskId,
    firstDispatchTs: "2026-11-03T10:00:00.000Z",
    dispatcher: "seat-one",
    dispatchRule: null,
    classAtDispatch: "upkeep",
    sourceAtDispatch: "plan",
    servesAtDispatch: null,
    rankAtDispatch: null,
    ageAtDispatchH: 48,
    ruleRankPct: null,
    inRuleTopk: null,
    mergedAt: null,
    prs: 0,
    fixRounds: 0,
    reviewRounds: 0,
    revertedBy: null,
    doneReason: null,
    followupsN: 0,
    followupsEst: 0,
    briefHasDoneWhen: null,
    leadCreatedDoneH: null,
    leadDispatchMergeH: null,
    usd: null,
    usdLink: null,
    ownerGates: 0,
    ownerGateHours: 0,
    dupPrs: 0,
    provenance: {},
    inputsHash: `hash-${taskId}`,
    ...fields,
  };
}

const MERGED = "2026-11-04T10:00:00.000Z";

/** Four picks by the population's seats in the window, plus one outside each bound of it. */
const ROWS: TaskRow[] = [
  row("AA-1", { classAtDispatch: "product", sourceAtDispatch: "owner", ageAtDispatchH: 2, prs: 1, mergedAt: MERGED, followupsN: 2 }),
  row("AA-2", { sourceAtDispatch: "follow-up", ageAtDispatchH: 10, prs: 1, mergedAt: MERGED, fixRounds: 3 }),
  row("AA-3", { dispatcher: "seat-two", prs: 1, fixRounds: 1 }),
  row("AA-4", { firstDispatchTs: "2026-11-10T09:00:00.000Z", sourceAtDispatch: "sweep", followupsN: 1 }),
  row("AA-5", { dispatcher: "seat-three", mergedAt: MERGED }),
  row("AA-6", { firstDispatchTs: "2026-11-12T13:00:00.000Z" }),
];

const RAW_CLASS = new Map<string, ClassLabel>([
  ["alpha/AA-1", "product"],
  ["alpha/AA-2", "mixed"],
  ["alpha/AA-3", "upkeep"],
  ["alpha/AA-4", "mixed"],
]);

/** The frozen expected values for the synthetic slice above. */
function frozenSlice(): ExpectedFile {
  return parseExpected({
    source: "synthetic slice",
    window: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-12T12:30:00.000Z" },
    populations: { seats: ["seat-one", "seat-two"] },
    selfSources: ["follow-up", "sweep"],
    figures: [
      { metric: "tasks", expected: 4, tolerance: { pct: 1 } },
      { metric: "class-share", class: "mixed", expected: 50, tolerance: { pp: 2 } },
      { metric: "class-share", class: "product", expected: 25, tolerance: { pp: 2 } },
      { metric: "merged-share", expected: 50, tolerance: { pp: 2 } },
      { metric: "fix-rounds-zero-share", expected: 33.3, tolerance: { pp: 2 } },
      { metric: "fix-rounds-3plus-share", expected: 33.3, tolerance: { pp: 2 } },
      { metric: "follow-ups-filed", expected: 3, tolerance: { pct: 5 } },
      { metric: "follow-up-sources", expected: 2, tolerance: { pct: 5 } },
      { metric: "week-picks", week: "2026-W45", expected: 3, tolerance: { pct: 2 } },
      { metric: "week-product-share", week: "2026-W45", expected: 33.3, tolerance: { pp: 3 } },
      { metric: "week-filed-1d-share", week: "2026-W45", expected: 66.7, tolerance: { pp: 3 } },
      { metric: "week-self-share", week: "2026-W46", expected: 100, tolerance: { pp: 3 } },
      { metric: "week-owner-share", week: "2026-W45", expected: 33.3, tolerance: { pp: 3 } },
    ],
  });
}

const INPUT = { rows: ROWS, rawClass: RAW_CLASS, sample: null };

describe("ticket-scorecard reproduce", () => {
  it("reproduce passes on the frozen fixture slice", () => {
    const report = reproduce(INPUT, frozenSlice(), "seats");

    expect(report.lines.filter((l) => l.verdict !== "pass")).toEqual([]);
    expect(report).toMatchObject({ ok: true, populationRows: 4 });
  });

  it("reproduce flags a miss outside tolerance", () => {
    const spec = frozenSlice();
    const figures = spec.figures.map((f) => (f.metric === "merged-share" ? { ...f, expected: 52.5 } : f));

    const report = reproduce(INPUT, { ...spec, figures }, "seats");

    expect(report.ok).toBe(false);
    expect(report.lines.find((l) => l.figure === "merged-share")).toMatchObject({ actual: 50, verdict: "miss" });
    expect(report.lines.filter((l) => l.verdict === "miss")).toHaveLength(1);
    expect(renderReport(report)).toContain("| merged-share | 52.5 | ±2 pp | 50 | miss |  |");
  });

  it("a figure the rows cannot give yet is not measured, with the reason, never zero", () => {
    const spec = { ...frozenSlice(), figures: e1ExpectedFile().figures.filter((f) => f.metric === "reverted" || f.metric === "week-rule-topk-share") };

    const report = reproduce(INPUT, spec, "seats");

    expect(report.ok).toBe(false);
    expect(report.lines.every((l) => l.verdict === "not measured" && l.actual === null && l.note !== null)).toBe(true);
  });

  it("reproduce gives each week's population and the share whose dispatch link is inferred", () => {
    const rows = ROWS.map((r) => (r.taskId === "AA-2" ? { ...r, provenance: { firstDispatchTs: "inferred:name" as const } } : r));
    const counts = { linked: 1, several: 2, none: 3, noOrigin: 4 };

    const report = reproduce({ ...INPUT, rows }, frozenSlice(), "seats", counts);

    expect(report.weeks).toEqual([
      { week: "2026-W45", tasks: 3, inferredLink: 1 },
      { week: "2026-W46", tasks: 1, inferredLink: 0 },
    ]);
    expect(renderReport(report)).toContain("| 2026-W45 | 3 | 1 | 33.3% |");
    expect(renderReport(report)).toContain("unlinked 9 (2 several tasks, 3 no task, 4 no origin)");
  });

  it("the bundled E1 file parses with the plan's tolerance on every figure", () => {
    const spec = e1ExpectedFile();

    expect(spec.figures).toHaveLength(63);
    expect(spec.populations["coordinator-seats"]).toHaveLength(7);
    expect(spec.figures.find((f) => f.metric === "reverted")?.tolerance).toEqual({ exact: true });
  });
});
