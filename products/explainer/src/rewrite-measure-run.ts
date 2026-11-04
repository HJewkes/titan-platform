import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { L0_CHECKS, runL0, type L0Result } from "./eval-l0.js";
import { vettableSentences } from "./lint-voice.js";
import { measureTable, summarizeMeasure, type MeasureInput, type MeasureSummary } from "./rewrite-measure.js";
import type { RewriteResult, TargetRow } from "./rewrite-pass.js";
import { REWRITE_TARGET_ROWS } from "./rewrite-plan.js";
import { ScriptSchema, type ScriptV1 } from "./script-schema.js";
import { speechVerdict, vetSentences, withSpeechVerdict, type SentenceVet } from "./speech-vet-gate.js";

const EXIT = { OK: 0, RED: 1 } as const;

interface MeasureOptions {
  outDir: string;
  samples: number;
  /** Stops before a run whose cost, estimated as the dearest run so far, would take the total past it. */
  maxUsd?: number;
  /** `input:row` cells that count toward the row mean but need not move closer. */
  reportOnly: ReadonlySet<string>;
}

/** How a measure reads an input, runs one rewrite of it and scores a script; a test passes a fake runner, so no model is called. */
interface MeasureEnv {
  read: (file: string) => ScriptV1;
  run: (script: ScriptV1) => Promise<RewriteResult>;
  score: (script: ScriptV1) => Promise<L0Result[]>;
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

/**
 * Scores a script with L0 as `eval l0` does. With a vetter, Q-V9 reads its verdicts on 26-32 word sentences, so a
 * sentence the pass kept under `--speech-vet` is not counted as over the cap; a vetter that cannot be built falls back to the cap.
 */
export function l0Scorer(vetter: (() => Promise<SentenceVet>) | undefined, err: (text: string) => void): MeasureEnv["score"] {
  return async (script) => {
    if (!vetter || vettableSentences(script.beats).length === 0) return runL0(script);
    let vet: SentenceVet;
    try {
      vet = await vetter();
    } catch (error) {
      err(`speech-vet: unavailable (${errorText(error)}); L0 keeps the plain sentence cap\n`);
      return runL0(script);
    }
    return runL0(script, undefined, withSpeechVerdict(L0_CHECKS, speechVerdict(await vetSentences(script, vet))));
  };
}

async function loadInput(file: string, outDir: string, env: MeasureEnv): Promise<Input> {
  const name = inputName(file);
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const script = env.read(file);
  const rows = await env.score(script);
  writeJson(join(dir, "before.l0.json"), rows);
  return { name, dir, script, before: targetRows(rows), samples: [] };
}

const samplePath = (input: Input, sample: number, kind: "rewrite" | "report" | "l0"): string => join(input.dir, `s${sample}.${kind}.json`);

const StoredSpendSchema = z.object({ usd: z.number() });

interface Rewritten {
  usd: number;
  script: ScriptV1;
}

const isStored = (input: Input, sample: number): boolean =>
  existsSync(samplePath(input, sample, "report")) && existsSync(samplePath(input, sample, "rewrite"));

/** A sample a previous measure already paid for, so a rerun after a stop pays only for what is missing. */
function storedRun(input: Input, sample: number): Rewritten | undefined {
  if (!isStored(input, sample)) return undefined;
  const usd = StoredSpendSchema.parse(readJson(samplePath(input, sample, "report"))).usd;
  return { usd, script: ScriptSchema.parse(readJson(samplePath(input, sample, "rewrite"))) };
}

async function freshRun(input: Input, sample: number, env: MeasureEnv): Promise<Rewritten> {
  const { script, report } = await env.run(input.script);
  writeJson(samplePath(input, sample, "rewrite"), script);
  writeJson(samplePath(input, sample, "report"), report);
  return { usd: report.usd, script };
}

/** Every sample is scored afresh, a stored one too: scoring costs nothing and keeps its L0 file current. */
async function runSample(input: Input, sample: number, env: MeasureEnv): Promise<Run> {
  try {
    const stored = storedRun(input, sample);
    const { usd, script } = stored ?? (await freshRun(input, sample, env));
    const rows = await env.score(script);
    writeJson(samplePath(input, sample, "l0"), rows);
    input.samples.push(targetRows(rows));
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
      const next = isStored(input, sample) ? 0 : dearest(runs);
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
  const inputs: Input[] = [];
  for (const file of files) inputs.push(await loadInput(file, options.outDir, env));
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
