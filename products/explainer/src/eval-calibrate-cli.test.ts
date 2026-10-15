import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli } from "./eval-cli.js";
import { appendTsv, STRUCTURE_COLUMNS, type StructureRow } from "./eval-store.js";
import { V4_LABELS_PATH } from "./spike-fixtures.test-helpers.js";

let dir: string;
let log: ReturnType<typeof vi.spyOn>;

const row = (script_sha: string, check_id: string, detail_beats: string[], severity: StructureRow["severity"] = "error"): StructureRow => ({
  config_id: "v4", script_sha, rules_sha: "r", check_id, mode: "tagged", severity, value: detail_beats.length, threshold: 0, pass: detail_beats.length === 0, detail_beats,
});
const structure = (rows: StructureRow[]): string => {
  const path = join(dir, "structure.tsv");
  appendTsv(path, STRUCTURE_COLUMNS, rows);
  return path;
};
const printed = (): string => log.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
const calibrateJson = async (...args: string[]): Promise<unknown> => {
  expect(await runEvalCli(["eval", "calibrate", ...args, "--labels", V4_LABELS_PATH, "--format", "json"])).toBe(0);
  return JSON.parse(printed());
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explainer-calibrate-"));
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe("explainer eval calibrate", () => {
  it("scores a structure.tsv and a JSON file of judge rows together, filtered to one script", async () => {
    const tsv = structure([row("v4sha", "Q-E7", ["r2-1-jobs", "r2-2-inv"]), row("v4sha", "Q-E9", [], "warning"), row("other", "Q-E7", ["r1-7-promise"])]);
    const judged = join(dir, "m3.json");
    writeFileSync(judged, JSON.stringify([{ check_id: "M3", severity: "warning", pass: false, detail_beats: ["r2-1-jobs", "r1-5-seams", "r4-1-plan"], script_sha: "v4sha" }]));

    const result = await calibrateJson(tsv, judged, "--script-sha", "v4sha");

    expect(result).toMatchObject({
      checks: [
        { check: "M1", ran: true, precision: 1, recall: 0.4 },
        { check: "M2", ran: false },
        { check: "M3", ran: true, precision: 0.5, recall: 0.25, borderline: ["r4-1-plan"] },
        { check: "M4", ran: true, precision: null, recall: 0 },
        { check: "M5", ran: false },
        { check: "M7", ran: false },
      ],
      owner: { named: ["r2-1-jobs", "r2-2-inv"], caught: ["r2-1-jobs", "r2-2-inv"], recall: 1 },
    });
  });

  it("prints a per-check table with precision, recall and the owner-named recall line", async () => {
    const tsv = structure([row("s", "Q-E7", ["r2-1-jobs"])]);

    expect(await runEvalCli(["eval", "calibrate", tsv, "--labels", V4_LABELS_PATH])).toBe(0);

    const out = printed();
    expect(out).toContain("check\tran\ttp\tfp\tborderline\tunlabelled\tprecision\trecall\tmissed");
    expect(out).toContain("M1\tyes\t1\t0\t0\t0\t1.00\t0.20\tr2-2-inv,r3-1-nouns,r10-1-calls,r10-7-followups");
    expect(out).toContain("M2\tno\t0\t0\t0\t0\t-\t-\t-\n");
    expect(out).toContain("owner-named recall (error checks): 1/2 = 0.50; missed r2-2-inv");
  });

  it("exits 2 on a rows file that is not in the row shape", async () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify([{ check_id: "M3", pass: "maybe" }]));

    expect(await runEvalCli(["eval", "calibrate", bad, "--labels", V4_LABELS_PATH])).toBe(2);
  });
});
