import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { floorSection, measureAaFloor, NOTES_END, NOTES_START, readFloor, writeFloorNotes, type AaFloor } from "./aa-floor.js";
import type { TargetRow } from "./rewrite-pass.js";
import { NO_USAGE, type StageRecord } from "./workflow/records.js";
import type { SampleEnv } from "./workflow/samples-measure.js";

const numbers = (value: number): TargetRow[] => [{ check_id: "register:numbers", value, threshold: 25, pass: value <= 25 }];
const record = (draft: string): StageRecord => ({
  stage: "script", bridged: false, startedAt: "t", endedAt: "t", wallMs: 1, usage: { ...NO_USAGE, usd: 1, calls: 1 }, retries: 0, outputs: { draft }, checks: [], notes: [],
});

/** Sample k of a case drafts a script whose numbers row reads `values[k]`. */
function env(values: Record<string, number[]>): SampleEnv & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async (inputs, sample) => {
      calls.push(`${inputs.spine}#${sample}`);
      return record(`d${values[inputs.spine!]![sample]}`);
    },
    score: (sha) => numbers(Number(sha.slice(1))),
  };
}

const cases = [{ name: "case-a", inputs: { spine: "a", facts: "f" } }, { name: "case-b", inputs: { spine: "b", facts: "f" } }];
const now = () => new Date("2026-10-22T12:00:00Z");

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("measureAaFloor", () => {
  it("runs arm A on samples 0..n-1 and arm B on n..2n-1, and pools σ within each arm", async () => {
    // Each arm of each case holds values spread 1 apart, so every arm's sample sd is 1.
    const fake = env({ a: [20, 21, 22, 21, 22, 23], b: [10, 11, 12, 30, 31, 32] });

    const floor = await measureAaFloor({ stage: "script", cases, samplesPerArm: 3, now }, fake);

    expect(fake.calls).toEqual(["a#0", "b#0", "a#1", "b#1", "a#2", "b#2", "a#3", "b#3", "a#4", "b#4", "a#5", "b#5"]);
    expect(floor.sigma["register:numbers"]).toBeCloseTo(1);
    expect(floor).toMatchObject({ cases: ["case-a", "case-b"], samplesPerArm: 3, spentUsd: 12, runs: 12, failedRuns: 0, measuredAt: "2026-10-22T12:00:00.000Z" });
  });

  it("calls the A/A difference noise when the arms differ by less than 2σ", async () => {
    const floor = await measureAaFloor({ stage: "script", cases: cases.slice(0, 1), samplesPerArm: 3, now }, env({ a: [20, 21, 22, 21, 22, 23] }));

    expect(floor.rows).toEqual([expect.objectContaining({ row: "register:numbers", diff: 1, verdict: "noise" })]);
  });

  it("shares one spend cap over both arms and skips arm B once arm A stopped", async () => {
    const fake = env({ a: [20, 21, 22, 21, 22, 23] });

    const floor = await measureAaFloor({ stage: "script", cases: cases.slice(0, 1), samplesPerArm: 3, maxUsd: 4, now }, fake);

    expect(fake.calls).toEqual(["a#0", "a#1", "a#2", "a#3"]);
    expect(floor.stopped).toMatch(/^spend cap: \$4\.0000 spent/);
    expect(floor.spentUsd).toBe(4);
  });
});

const FLOOR: AaFloor = {
  schema: "explainer.aa-floor/v1", stage: "script", measuredAt: "2026-10-22T12:00:00.000Z", cases: ["case-a"], samplesPerArm: 3,
  sigma: { "register:numbers": 1.25 }, spentUsd: 3.5, runs: 6, failedRuns: 0,
  rows: [{ row: "register:numbers", band: { min: 11.92, max: 25.62 }, meanA: 21, meanB: 22, diff: 1, sigma: 1.25, sigmaFrom: "floor", verdict: "noise" }],
};

describe("floor notes", () => {
  it("prints σ, the 2σ band and the A/A verdict per row", () => {
    expect(floorSection(FLOOR)).toContain("| register:numbers | 1.250 | ± 2.500 | +1.000 | noise |");
  });

  it("writes notes.md and aa-floor.json, and a new floor replaces only the marked section", () => {
    dir = mkdtempSync(path.join(tmpdir(), "aa-floor-"));
    writeFileSync(path.join(dir, "notes.md"), `# kept heading\n\nkept text\n\n${NOTES_START}\nold floor\n${NOTES_END}\n\nkept tail\n`);

    writeFloorNotes(dir, FLOOR);
    const notes = readFileSync(path.join(dir, "notes.md"), "utf8");

    expect(notes).toContain("kept text");
    expect(notes).toContain("kept tail");
    expect(notes).not.toContain("old floor");
    expect(notes).toContain("## A/A noise floor (script)");
    expect(readFloor(dir).sigma).toEqual({ "register:numbers": 1.25 });
  });

  it("starts a notes file with the unit's name when none exists", () => {
    dir = mkdtempSync(path.join(tmpdir(), "aa-floor-"));

    writeFloorNotes(dir, FLOOR);

    expect(readFileSync(path.join(dir, "notes.md"), "utf8")).toMatch(new RegExp(`^# ${path.basename(dir)} notes\n\n${NOTES_START}`));
  });
});
