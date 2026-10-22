import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { runL0, type L0Result } from "./eval-l0.js";
import { measureTable, summarizeMeasure, type MeasureInput, type MeasureSummary } from "./rewrite-measure.js";
import type { RewriteResult, TargetRow } from "./rewrite-pass.js";
import { REWRITE_TARGET_ROWS } from "./rewrite-plan.js";
import type { ScriptV1 } from "./script-schema.js";

const EXIT = { OK: 0, RED: 1 } as const;

interface MeasureOptions {
  outDir: string;
  samples: number;
  /** Stops before a run whose cost, estimated as the dearest run so far, would take the total past it. */
  maxUsd?: number;
  /** `input:row` cells that count toward the row mean but need not move closer. */
  reportOnly: ReadonlySet<string>;
}

/** How a measure reads an input and runs one rewrite of it; a test passes a fake runner, so no model is called. */
interface MeasureEnv {
  read: (file: string) => ScriptV1;
  run: (script: ScriptV1) => Promise<RewriteResult>;
  out: (text: string) => void;
  err: (text: string) => void;
}

interface Input {
  name: string;
  dir: string;
  script: ScriptV1;
  before: TargetRow[];
  samples: TargetRow[][];
}

interface Run {
  input: string;
  sample: number;
  usd: number;
  reused: boolean;
  error?: string;
}

const TARGETS: ReadonlySet<string> = new Set(REWRITE_TARGET_ROWS);
const targetRows = (rows: readonly L0Result[]): TargetRow[] =>
  rows.filter((row) => TARGETS.has(row.check_id)).map(({ check_id, value, threshold, pass }) => ({ check_id, value, threshold, pass }));

const writeJson = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const inputName = (file: string): string => basename(file).replace(/(\.spike)?\.json$/, "");
const money = (usd: number): number => Number(usd.toFixed(4));

function loadInput(file: string, outDir: string, env: MeasureEnv): Input {
  const name = inputName(file);
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const script = env.read(file);
  const rows = runL0(script);
  writeJson(join(dir, "before.l0.json"), rows);
  return { name, dir, script, before: targetRows(rows), samples: [] };
}

const samplePath = (input: Input, sample: number, kind: "rewrite" | "report" | "l0"): string => join(input.dir, `s${sample}.${kind}.json`);

const StoredSpendSchema = z.object({ usd: z.number() });
const StoredRowsSchema = z.array(z.object({ check_id: z.string(), value: z.number(), threshold: z.number(), pass: z.boolean() }));

interface Scored {
  usd: number;
  rows: TargetRow[];
}

/** A sample a previous measure already wrote, so a rerun after a stop pays only for what is missing. */
function storedRun(input: Input, sample: number): Scored | undefined {
  const [report, l0] = [samplePath(input, sample, "report"), samplePath(input, sample, "l0")];
  if (!existsSync(report) || !existsSync(l0)) return undefined;
  const rows = StoredRowsSchema.parse(readJson(l0)).filter((row) => TARGETS.has(row.check_id));
  return { usd: StoredSpendSchema.parse(readJson(report)).usd, rows };
}

async function freshRun(input: Input, sample: number, env: MeasureEnv): Promise<Scored> {
  const { script, report } = await env.run(input.script);
  const rows = runL0(script);
  writeJson(samplePath(input, sample, "rewrite"), script);
  writeJson(samplePath(input, sample, "report"), report);
  writeJson(samplePath(input, sample, "l0"), rows);
  return { usd: report.usd, rows: targetRows(rows) };
}

async function runSample(input: Input, sample: number, env: MeasureEnv): Promise<Run> {
  const stored = storedRun(input, sample);
  try {
    const { usd, rows } = stored ?? (await freshRun(input, sample, env));
    input.samples.push(rows);
    return { input: input.name, sample, usd, reused: stored !== undefined };
  } catch (error) {
    return { input: input.name, sample, usd: 0, reused: false, error: errorText(error) };
  }
}

const spent = (runs: readonly Run[]): number => runs.reduce((sum, run) => sum + run.usd, 0);
const dearest = (runs: readonly Run[]): number => Math.max(0, ...runs.map((run) => run.usd));

/** Sample-major, so a spend stop leaves every input with the same number of samples, give or take one. */
async function runAll(inputs: readonly Input[], options: MeasureOptions, env: MeasureEnv): Promise<{ runs: Run[]; stopped?: string }> {
  const runs: Run[] = [];
  for (let sample = 1; sample <= options.samples; sample++) {
    for (const input of inputs) {
      const next = storedRun(input, sample) ? 0 : dearest(runs);
      if (options.maxUsd !== undefined && spent(runs) + next > options.maxUsd) {
        return { runs, stopped: `spend cap: $${money(spent(runs))} spent, the next run (est. $${money(next)}) would pass $${options.maxUsd}` };
      }
      const run = await runSample(input, sample, env);
      runs.push(run);
      env.out(`${JSON.stringify({ ...run, usd: money(run.usd), total_usd: money(spent(runs)) })}\n`);
    }
  }
  return { runs };
}

function checkNames(names: readonly string[], reportOnly: ReadonlySet<string>): void {
  if (new Set(names).size !== names.length) throw new Error(`two inputs share a name: ${names.join(", ")}`);
  const cells = new Set(names.flatMap((name) => REWRITE_TARGET_ROWS.map((row) => `${name}:${row}`)));
  const unknown = [...reportOnly].filter((cell) => !cells.has(cell));
  if (unknown.length > 0) throw new Error(`--report-only names no input and target row: ${unknown.join(", ")}`);
}

const measureInputs =(inputs: readonly Input[]): MeasureInput[] => inputs.map(({ name, before, samples }) => ({ name, before, samples }));

function writeSummary(outDir: string, summary: MeasureSummary, runs: readonly Run[], stopped: string | undefined): void {
  const spend = { total_usd: money(spent(runs)), runs: runs.map((run) => ({ ...run, usd: money(run.usd) })) };
  writeJson(join(outDir, "measure.json"), { ...summary, spend, ...(stopped ? { stopped } : {}) });
  writeFileSync(join(outDir, "table.md"), `${measureTable(summary)}\nSpend: $${spend.total_usd} over ${runs.length} runs.${stopped ? ` Stopped: ${stopped}.` : ""}\n`);
}

/**
 * Rewrites each input `samples` times, scores every output with L0, and writes the per-cell and per-row summary.
 * Exit 0 when every run finished and the revised done-when holds, 1 otherwise.
 */
export async function measureRewrite(files: readonly string[], options: MeasureOptions, env: MeasureEnv): Promise<number> {
  checkNames(files.map(inputName), options.reportOnly);
  mkdirSync(options.outDir, { recursive: true });
  const inputs = files.map((file) => loadInput(file, options.outDir, env));
  const { runs, stopped } = await runAll(inputs, options, env);
  runs.filter((run) => run.error).forEach((run) => env.err(`${run.input} sample ${run.sample}: ${run.error}\n`));
  if (stopped) env.err(`${stopped}\n`);
  const summary = summarizeMeasure(measureInputs(inputs), options.reportOnly);
  writeSummary(options.outDir, summary, runs, stopped);
  const failedRuns = runs.filter((run) => run.error).length;
  const line = { out_dir: options.outDir, pass: summary.pass, runs: runs.length, failed_runs: failedRuns, total_usd: money(spent(runs)) };
  env.out(`${JSON.stringify({ ...line, ...(stopped ? { stopped } : {}) })}\n`);
  return summary.pass && !stopped && failedRuns === 0 ? EXIT.OK : EXIT.RED;
}
