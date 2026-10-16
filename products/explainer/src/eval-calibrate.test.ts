import { describe, expect, it } from "vitest";
import { z } from "zod";
import { calibrate, LabelsSchema, ownerRecall, scoreCheck, type CalibrationRow, type CheckLabels, type Labels } from "./eval-calibrate.js";
import { v4Durations, v4Labels, v4Script } from "./spike-fixtures.test-helpers.js";

const labels = (): Labels => LabelsSchema.parse(v4Labels());
const check = (name: string): CheckLabels => {
  const found = labels().checks.find((c) => c.check === name);
  if (!found) throw new Error(`no ${name} labels`);
  return found;
};
const failing = (check_id: string, detail_beats: string[], severity: CalibrationRow["severity"] = "error"): CalibrationRow => ({ check_id, severity, pass: false, detail_beats });

const idList = z.array(z.object({ id: z.string() }));
const DurationsIds = z.object({ beats: idList });
const ChapterIds = z.object({ chapters: idList });

/** The ten beats the M3 pre-check routes to the item judge on v4. */
const M3_ROUTED = ["r1-5-seams", "r1-7-promise", "r2-1-jobs", "r3-7-simple", "r4-1-plan", "r7-3-caps", "r7-4b-score", "r10-6b-q10-q11", "r10-7-followups", "r10-7b-research"];

describe("v4 labels.json", () => {
  it("holds the plan's beat, chapter and item labels", () => {
    const parsed = labels();

    expect(parsed.checks.map((c) => [c.check, c.true.length, c.false.length, c.borderline.length])).toEqual([
      ["M1", 5, 0, 0], ["M2", 5, 1, 0], ["M3", 4, 4, 2], ["M4", 4, 5, 0], ["M5", 1, 1, 0], ["M7", 1, 0, 1],
    ]);
    expect(parsed.owner_named).toMatchObject({ true: ["r2-1-jobs", "r2-2-inv"], borderline: ["r2-3-limits", "r2-4-measure"] });
    expect(parsed.items).toHaveLength(6);
  });

  it("names only beats and chapters that exist in the v4 fixture", () => {
    const beats = new Set(DurationsIds.parse(v4Durations()).beats.map((b) => b.id));
    const chapters = new Set(ChapterIds.parse(v4Script()).chapters.map((c) => c.id));
    const parsed = labels();

    const beatIds = [...parsed.checks.filter((c) => c.level === "beat").flatMap((c) => [...c.true, ...c.false, ...c.borderline]), ...parsed.owner_named.true, ...parsed.owner_named.borderline, ...parsed.items.flatMap((i) => i.first_used)];
    const chapterIds = parsed.checks.filter((c) => c.level === "chapter").flatMap((c) => [...c.true, ...c.false, ...c.borderline]);
    expect(beatIds.filter((id) => !beats.has(id))).toEqual([]);
    expect(chapterIds.filter((id) => !chapters.has(id))).toEqual([]);
  });

  it("refuses a check that labels one beat twice", () => {
    const twice = { ...labels(), checks: [{ ...check("M5"), false: ["r2-2-inv"] }] };

    expect(() => LabelsSchema.parse(twice)).toThrow(/r2-2-inv labelled more than once/);
  });
});

describe("scoreCheck", () => {
  it("scores M3 over the ten routed beats at precision 0.5 and recall 1, with both borderlines counted as neither", () => {
    const score = scoreCheck(check("M3"), [failing("M3", M3_ROUTED)]);

    expect(score).toMatchObject({ ran: true, precision: 0.5, recall: 1, borderline: ["r4-1-plan", "r7-4b-score"], unlabelled: [], missed: [] });
    expect(score.false_positives).toHaveLength(4);
  });

  it("leaves precision and recall unchanged when a borderline beat is added to the flags", () => {
    const without = scoreCheck(check("M3"), [failing("M3", ["r2-1-jobs", "r1-5-seams"])]);
    const withBorderline = scoreCheck(check("M3"), [failing("M3", ["r2-1-jobs", "r1-5-seams", "r4-1-plan"])]);

    expect([withBorderline.precision, withBorderline.recall]).toEqual([without.precision, without.recall]);
    expect([without.precision, without.recall]).toEqual([0.5, 0.25]);
  });

  it("scores a pace check through its rule id, and a chapter check by chapter", () => {
    const m1 = scoreCheck(check("M1"), [failing("Q-E7", ["r2-1-jobs", "r2-2-inv", "r3-1-nouns"]), failing("Q-E8", ["r1-7-promise"], "warning")]);
    const m7 = scoreCheck(check("M7"), [failing("Q-E10", ["ch2", "ch10", "ch5"], "warning")]);

    expect(m1).toMatchObject({ precision: 1, recall: 0.6, missed: ["r10-1-calls", "r10-7-followups"] });
    expect(m7).toMatchObject({ precision: 1, recall: 1, borderline: ["ch10"], unlabelled: ["ch5"] });
  });

  it("reports a check with no rows as not run, and a passing check as run with zero recall", () => {
    const passing: CalibrationRow = { check_id: "Q-E9", severity: "warning", pass: true, detail_beats: [] };

    expect(scoreCheck(check("M4"), [])).toMatchObject({ ran: false, precision: null, recall: null });
    expect(scoreCheck(check("M4"), [passing])).toMatchObject({ ran: true, precision: null, recall: 0 });
  });
});

describe("ownerRecall", () => {
  it("counts an owner-named beat caught only when an error-severity row fails on it", () => {
    const rows = [failing("Q-E7", ["r2-1-jobs"]), failing("Q-E8", ["r2-2-inv"], "warning")];

    expect(ownerRecall(labels(), rows)).toEqual({ named: ["r2-1-jobs", "r2-2-inv"], caught: ["r2-1-jobs"], recall: 0.5 });
  });

  it("reads the named beats from the labels: dropping r2-1-jobs from them changes the recall", () => {
    const rows = [failing("Q-E7", ["r2-2-inv", "r2-3-limits"])];
    const trimmed = { ...labels(), owner_named: { true: ["r2-2-inv"], borderline: [] } };

    expect(ownerRecall(labels(), rows).recall).toBe(0.5);
    expect(ownerRecall(trimmed, rows).recall).toBe(1);
  });

  it("does not count a caught borderline owner beat", () => {
    expect(ownerRecall(labels(), [failing("Q-E7", ["r2-3-limits", "r2-4-measure"])]).recall).toBe(0);
  });
});

describe("calibrate", () => {
  it("scores every labelled check and the owner recall in one pass", () => {
    const result = calibrate(labels(), [failing("Q-E7", ["r2-1-jobs", "r2-2-inv"])]);

    expect(result.script).toBe("redesign-explainer-v4");
    expect(result.checks.map((c) => [c.check, c.ran])).toEqual([["M1", true], ["M2", false], ["M3", false], ["M4", false], ["M5", false], ["M7", false]]);
    expect(result.owner.recall).toBe(1);
  });
});
