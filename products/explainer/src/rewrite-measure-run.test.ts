import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { usePreCalibrationStatuses } from "./writing-statuses-fixtures.test-helpers.js";
import { sonnet } from "./judge-fakes.test-helpers.js";
import { runRewriteCli } from "./rewrite-cli.js";
import { choppy, cuedChoppy, fakeRewriter } from "./rewrite-fixtures.test-helpers.js";
import type { MeasureSummary } from "./rewrite-measure.js";
import type { RewriteResult } from "./rewrite-pass.js";
import type { ScriptV1 } from "./script-schema.js";

// These tests pin the mechanics on fixtures; the shipped status table is data a recalibration changes (TP-4662).
usePreCalibrationStatuses();

type MeasureFile = MeasureSummary & { spend: { total_usd: number }; stopped?: string };

let dir: string;
const write = (name: string, value: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
// One 30-word sentence: past the plain 25-word cap, inside the vetted one.
const LONG_H1 =
  "When a courier asks for a label, the desk refuses ghost labels, so it looks for the parcel row and waits for the ledger before it prints anything at all.";

const outDir = (): string => join(dir, "measure");
const readRows = (path: string): { check_id: string; pass: boolean }[] => JSON.parse(readFileSync(path, "utf8"));
const readMeasure = (): MeasureFile => JSON.parse(readFileSync(join(outDir(), "measure.json"), "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explainer-measure-"));
});

/** A runner that returns the script unchanged at a fixed cost, or fails on the calls `fails` names (1-based). */
function fakeRunner(usd: number, fails: ReadonlySet<number> = new Set()) {
  let calls = 0;
  const run = async (script: ScriptV1): Promise<RewriteResult> => {
    calls += 1;
    if (fails.has(calls)) throw new Error("model_error: offline");
    return { script, report: { judge: "fake", before: [], after: [], rounds: [], calls: [], usd, tokensIn: 0, tokensOut: 0 } };
  };
  return { run, calls: () => calls };
}

async function measure(extra: string[], runner: ReturnType<typeof fakeRunner>, inputs = ["alpha.json", "beta.spike.json"]) {
  const out: string[] = [];
  const err: string[] = [];
  const files = inputs.map((name) => write(name, choppy()));
  const argv = ["rewrite", "measure", ...files, "--judge", write("judge.json", sonnet), "--out-dir", outDir(), ...extra];
  const code = await runRewriteCli(argv, { rewriteRun: runner.run, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, lines: out.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line)), err: err.join("") };
}

describe("explainer rewrite measure", () => {
  it("rewrites each input n times, scores every output and reports each cell's mean, sd and n with the spend", async () => {
    const runner = fakeRunner(0.5);

    const { lines } = await measure(["--samples", "3"], runner);

    expect(runner.calls()).toBe(6);
    expect(existsSync(join(outDir(), "beta", "before.l0.json"))).toBe(true);
    expect(["s3.rewrite.json", "s3.report.json", "s3.l0.json"].every((file) => existsSync(join(outDir(), "alpha", file)))).toBe(true);
    const summary = readMeasure();
    expect(summary.cells).toHaveLength(10);
    expect(summary.cells.every((cell) => cell.n === 3 && cell.sd! < 1e-9)).toBe(true);
    expect(summary.rows).toHaveLength(5);
    expect(summary.spend.total_usd).toBe(3);
    expect(lines.at(-1)).toMatchObject({ runs: 6, failed_runs: 0, total_usd: 3 });
    expect(readFileSync(join(outDir(), "table.md"), "utf8")).toContain("Spend: $3 over 6 runs.");
  });

  it("stops before the run whose estimated cost would take the total past the spend cap, and exits 1", async () => {
    const runner = fakeRunner(0.5);

    const { code, lines, err } = await measure(["--samples", "3", "--max-usd", "1.2"], runner);

    expect(runner.calls()).toBe(2);
    expect(code).toBe(1);
    expect(err).toContain("spend cap");
    expect(lines.at(-1)).toMatchObject({ runs: 2, total_usd: 1 });
    expect(readMeasure()).toMatchObject({ stopped: expect.stringContaining("would pass $1.2") });
  });

  it("reuses samples a previous measure wrote and pays only for the missing ones", async () => {
    await measure(["--samples", "1"], fakeRunner(0.5));
    const rerun = fakeRunner(0.5);

    const { lines } = await measure(["--samples", "2"], rerun);

    expect(rerun.calls()).toBe(2);
    expect(lines.filter((line) => line.reused)).toHaveLength(2);
    expect(lines.at(-1)).toMatchObject({ runs: 4, total_usd: 2 });
  });

  it("names a failed run on stderr, leaves it out of its cell's n and exits 1", async () => {
    const { code, err } = await measure(["--samples", "2"], fakeRunner(0.5, new Set([2])));

    expect(code).toBe(1);
    expect(err).toContain("beta sample 1: model_error: offline");
    const cells = readMeasure().cells;
    expect(cells.filter((cell) => cell.input === "beta").every((cell) => cell.n === 1)).toBe(true);
  });

  it("runs the real pass through the judge harness and builds the speech vetter once for every sample", async () => {
    let built = 0;
    const speechVet = async () => {
      built += 1;
      return async () => ({ status: "accepted" });
    };
    const argv = ["rewrite", "measure", write("alpha.json", cuedChoppy()), "--judge", write("judge.json", sonnet), "--out-dir", outDir(), "--samples", "2", "--speech-vet"];

    const code = await runRewriteCli(argv, { harness: () => fakeRewriter().harness, speechVet, out: () => {}, err: () => {} });

    expect(code).toBe(0);
    expect(built).toBe(1);
    expect(readMeasure().spend.total_usd).toBeCloseTo(0.08);
  });

  it("scores a kept 26-32 word sentence with the speech-vet verdict under --speech-vet, as eval l0 does", async () => {
    const long = choppy({ h1: { spoken: LONG_H1 } });
    const keepLong = async (): Promise<RewriteResult> => ({ script: long, report: { judge: "fake", before: [], after: [], rounds: [], calls: [], usd: 0.1, tokensIn: 0, tokensOut: 0 } });
    const speechVet = async () => async () => ({ status: "accepted" });
    const run = async (extra: string[]) => {
      const argv = ["rewrite", "measure", write("alpha.json", choppy()), "--judge", write("judge.json", sonnet), "--out-dir", outDir(), ...extra];
      await runRewriteCli(argv, { rewriteRun: keepLong, speechVet, out: () => {}, err: () => {} });
      return readRows(join(outDir(), "alpha", "s1.l0.json")).find((row) => row.check_id === "Q-V9");
    };

    expect(await run(["--samples", "1"])).toMatchObject({ pass: false });
    expect(await run(["--samples", "1", "--speech-vet"])).toMatchObject({ pass: true });
  });

  it("exits 2 when a report-only cell names no input or target row", async () => {
    const runner = fakeRunner(0.5);

    const { code, err } = await measure(["--report-only", "gamma:register:numbers"], runner);

    expect(code).toBe(2);
    expect(err).toContain("gamma:register:numbers");
    expect(runner.calls()).toBe(0);
  });
});
