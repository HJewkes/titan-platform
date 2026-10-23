import { runL0 } from "../eval-l0.js";
import type { MeasureInput } from "../rewrite-measure.js";
import type { TargetRow } from "../rewrite-pass.js";
import { REWRITE_TARGET_ROWS } from "../rewrite-plan.js";
import { ScriptSchema } from "../script-schema.js";
import type { CachedStage, StageRecord } from "./records.js";
import { ChildStageFailure } from "./stage-cache.js";

/** The model stages a multi-sample measure scores: the script artifact each makes, and for rewrite the draft it starts from. */
export const SAMPLED_STAGES = { script: { output: "draft" }, rewrite: { output: "script", before: "draft" } } as const;
export type SampledStage = keyof typeof SAMPLED_STAGES;
export const isSampledStage = (stage: CachedStage): stage is SampledStage => Object.hasOwn(SAMPLED_STAGES, stage);

/** One frozen set of upstream artifacts, by name; an ev case's `input.inputs`. */
export interface SampleCase {
  name: string;
  inputs: Readonly<Record<string, string>>;
}

export interface SampleEnv {
  /** Runs the stage once through the stage cache; the sample index goes into its key. */
  run: (inputs: Readonly<Record<string, string>>, sample: number) => Promise<StageRecord>;
  /** The Q-V11 target rows of a script artifact in the store. */
  score: (sha: string) => TargetRow[];
  log?: (run: SampleRun & { totalUsd: number }) => void;
}

export interface SampleRun {
  case: string;
  sample: number;
  usd: number;
  cached: boolean;
  /** The stage failed a gate but still made its script, so the sample counts. */
  gateFailed?: boolean;
  /** No script came out, so the sample does not count. */
  error?: string;
}

export interface SampleRequest {
  stage: SampledStage;
  cases: readonly SampleCase[];
  /** The sample indices to run per case. */
  samples: readonly number[];
  /** Stops before a run whose cost, estimated as the dearest run so far, would take the total past it. */
  maxUsd?: number;
}

export interface SampleResult {
  inputs: MeasureInput[];
  runs: SampleRun[];
  spentUsd: number;
  stopped?: string;
}

const TARGETS: ReadonlySet<string> = new Set(REWRITE_TARGET_ROWS);

/** Scores a script/v1 text with every L0 check and keeps the rows a measure reads. */
export function targetRowsOf(text: string): TargetRow[] {
  return runL0(ScriptSchema.parse(JSON.parse(text)))
    .filter((row) => TARGETS.has(row.check_id))
    .map(({ check_id, value, threshold, pass }) => ({ check_id, value, threshold, pass }));
}

/** A case while its samples come in. */
interface Collecting {
  name: string;
  inputs: SampleCase["inputs"];
  before?: TargetRow[];
  samples: TargetRow[][];
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
export const sumUsd = (runs: readonly SampleRun[]): number => runs.reduce((sum, run) => sum + run.usd, 0);

/** A failed gate still leaves its record; a model stage's noise includes the samples that failed one. */
async function recordOf(env: SampleEnv, inputs: SampleCase["inputs"], sample: number): Promise<{ record?: StageRecord; gateFailed: boolean; error?: string }> {
  try {
    return { record: await env.run(inputs, sample), gateFailed: false };
  } catch (error) {
    if (error instanceof ChildStageFailure && error.record) return { record: error.record, gateFailed: true, error: errorText(error) };
    return { gateFailed: false, error: errorText(error) };
  }
}

async function runOne(request: SampleRequest, env: SampleEnv, input: Collecting, sample: number): Promise<SampleRun> {
  const { record, gateFailed, error } = await recordOf(env, input.inputs, sample);
  const base = { case: input.name, sample, usd: record?.usage.usd ?? 0, cached: record?.cached === true };
  const sha = record?.outputs[SAMPLED_STAGES[request.stage].output];
  if (sha === undefined) return { ...base, error: error ?? `stage ${request.stage} made no ${SAMPLED_STAGES[request.stage].output}` };
  try {
    input.samples.push(env.score(sha));
    return { ...base, ...(gateFailed ? { gateFailed } : {}) };
  } catch (scoreError) {
    return { ...base, error: `scoring ${sha.slice(0, 12)}: ${errorText(scoreError)}` };
  }
}

function startInput(request: SampleRequest, env: SampleEnv, c: SampleCase): Collecting {
  const beforeName = (SAMPLED_STAGES[request.stage] as { before?: string }).before;
  const beforeSha = beforeName === undefined ? undefined : c.inputs[beforeName];
  if (beforeName !== undefined && beforeSha === undefined) throw new Error(`case ${c.name} has no "${beforeName}" input for stage ${request.stage}`);
  return { name: c.name, inputs: c.inputs, samples: [], ...(beforeSha === undefined ? {} : { before: env.score(beforeSha) }) };
}

/**
 * Runs the stage `samples` times over each case and collects each output's target rows for summarizeMeasure.
 * Sample-major, so a spend stop leaves every case with the same number of samples, give or take one.
 */
export async function runSamples(request: SampleRequest, env: SampleEnv): Promise<SampleResult> {
  const inputs = request.cases.map((c) => startInput(request, env, c));
  const runs: SampleRun[] = [];
  const result = (stopped?: string): SampleResult =>
    ({ inputs: inputs.map(({ inputs: _, ...rest }) => rest), runs, spentUsd: sumUsd(runs), ...(stopped ? { stopped } : {}) });
  for (const sample of request.samples) {
    for (const input of inputs) {
      const next = Math.max(0, ...runs.map((run) => run.usd));
      if (request.maxUsd !== undefined && sumUsd(runs) + next > request.maxUsd) {
        return result(`spend cap: $${sumUsd(runs).toFixed(4)} spent, the next run (est. $${next.toFixed(4)}) would pass $${request.maxUsd}`);
      }
      const run = await runOne(request, env, input, sample);
      runs.push(run);
      env.log?.({ ...run, totalUsd: sumUsd(runs) });
    }
  }
  return result();
}

/** Sample indices `first` to `first + n - 1`. */
export const sampleRange = (first: number, n: number): number[] => Array.from({ length: n }, (_, i) => first + i);
