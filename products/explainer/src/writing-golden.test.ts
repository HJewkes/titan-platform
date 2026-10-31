import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli } from "./eval-cli.js";
import { REGISTER_METRICS, type RegisterMetric } from "./lint-register.js";
import { migrateSpike } from "./migrate.js";
import { parseWritingCheck, type BucketName } from "./writing-calibrate.js";
import { scoreWriting, type WritingBeat, type WritingReport } from "./writing-check.js";
import { applySeededEdit, SEEDED_DOSES, SEEDED_EDIT_NAMES, SEEDED_ROW, type SeededDose, type SeededEdit } from "./writing-seeded-edits.js";

interface RowGolden {
  value: number | null;
  outOfBand: boolean;
}
interface ScriptGolden {
  words: number;
  bucket: BucketName;
  rows: Record<RegisterMetric, RowGolden>;
}
interface Golden {
  clean: ScriptGolden;
  ours: Record<string, ScriptGolden>;
  seeded: Record<SeededEdit, { row: RegisterMetric; doses: Record<string, { words: number; value: number | null; outOfBand: boolean }> }>;
}

const fixture = (path: string): string => readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8");
const SHIPPED = fixture("../doctrine/writing-check.json");
const golden: Golden = JSON.parse(fixture("writing-check/golden.json"));
const table = parseWritingCheck(SHIPPED);
const cleanScript: { beats: WritingBeat[] } = JSON.parse(fixture("writing-check/clean.script.json"));
const cleanBeats = cleanScript.beats;
const oursBeats: Record<string, WritingBeat[]> = {
  "pipeline-explainer": migrateSpike(JSON.parse(fixture("spike/pipeline-explainer/script.json"))).beats,
  "redesign-explainer-v4": migrateSpike(JSON.parse(fixture("spike/redesign-explainer-v4/script-full.json"))).beats,
};

const row = (report: WritingReport, metric: RegisterMetric) => report.rows.find((candidate) => candidate.metric === metric)!;
const round2 = (value: number | null): number | null => (value === null ? null : Math.round(value * 100) / 100);
const judged = (status: string): boolean => status === "gate" || status === "warning";
/** What a row's verdict must be, given only its status from the table and whether its value left the band. */
const expectedVerdict = (status: string, outOfBand: boolean): string => (judged(status) ? (outOfBand ? "fail" : "pass") : "not-judged");
const outOfBand = (report: WritingReport, metric: RegisterMetric): boolean => {
  const { value, band } = row(report, metric);
  return value !== null && ((band.min !== undefined && value < band.min) || value > band.max);
};

describe("the clean synthetic script", () => {
  it("passes every gate and warning row and reports the golden values", () => {
    const report = scoreWriting(cleanBeats, table);

    expect(report.bucket).toBe(golden.clean.bucket);
    expect(report.words).toBe(golden.clean.words);
    for (const { metric, status, verdict, value } of report.rows) {
      expect(round2(value), metric).toBe(golden.clean.rows[metric].value);
      expect(verdict, metric).toBe(expectedVerdict(status, golden.clean.rows[metric].outOfBand));
      if (judged(status)) expect(verdict, `${metric} is ${status}`).toBe("pass");
    }
    expect(report.verdict).toMatchObject({ pass: true, gateFails: 0, warnings: 0 });
  });
});

describe("seeded edits on the clean script", () => {
  const cases = SEEDED_EDIT_NAMES.flatMap((edit) => SEEDED_DOSES.map((dose): [SeededEdit, SeededDose] => [edit, dose]));

  it.each(cases)("%s at %i per 1k moves its own row to the golden value", (edit, dose) => {
    const expected = golden.seeded[edit].doses[String(dose)]!;

    const report = scoreWriting(applySeededEdit(cleanBeats, edit, dose), table);

    expect(SEEDED_ROW[edit]).toBe(golden.seeded[edit].row);
    expect(round2(row(report, SEEDED_ROW[edit]).value)).toBe(expected.value);
    expect(outOfBand(report, SEEDED_ROW[edit])).toBe(expected.outOfBand);
  });

  it.each(SEEDED_EDIT_NAMES)("%s at 4 per 1k flips its row on the row's own status", (edit) => {
    const report = scoreWriting(applySeededEdit(cleanBeats, edit, 4), table);

    const { status, verdict } = row(report, SEEDED_ROW[edit]);
    expect(verdict).toBe(expectedVerdict(status, true));
  });

  it("flips the verdict of a script in the gate bucket for each gate row's seed, and no other seed", () => {
    const gateMetrics = REGISTER_METRICS.filter((metric) => table.statusByBucket[metric][golden.clean.bucket] === "gate");
    expect(gateMetrics.length).toBeGreaterThan(0);

    for (const edit of SEEDED_EDIT_NAMES) {
      const report = scoreWriting(applySeededEdit(cleanBeats, edit, 4), table);
      const seedsGate = gateMetrics.includes(SEEDED_ROW[edit]);
      expect(report.verdict.pass, edit).toBe(!seedsGate);
    }
  });
});

describe("the in-repo ours fixtures", () => {
  it.each(Object.keys(oursBeats))("%s keeps its pinned values and the verdict its status table gives", (name) => {
    const expected = golden.ours[name]!;

    const report = scoreWriting(oursBeats[name]!, table);

    expect(report.bucket).toBe(expected.bucket);
    expect(report.words).toBe(expected.words);
    for (const { metric, status, verdict, value } of report.rows) {
      expect(round2(value), metric).toBe(expected.rows[metric].value);
      expect(verdict, metric).toBe(expectedVerdict(status, expected.rows[metric].outOfBand));
    }
    const gateBreach = report.rows.some((candidate) => candidate.status === "gate" && expected.rows[candidate.metric].outOfBand);
    expect(report.verdict.pass).toBe(!gateBreach);
  });
});

describe("explainer eval writing on a seeded script", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "writing-golden-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  const exitFor = (beats: readonly WritingBeat[]): Promise<number> => {
    const script = join(dir, "script.txt");
    writeFileSync(script, beats.map((beat) => beat.spoken).join("\n"));
    return runEvalCli(["eval", "writing", script, "--format", "text"]);
  };

  it("exits 0 for the clean script and 1 once the gate row's seed is added", async () => {
    const seeded = applySeededEdit(cleanBeats, "verbless-no", 4);

    expect(await exitFor(cleanBeats)).toBe(0);
    expect(await exitFor(seeded)).toBe(1);
  });
});
