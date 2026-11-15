import type { ArResult } from "@titan-design/autoresearch";
import { arResultFor } from "../ar-result.js";
import { runCold, type ColdResult } from "../eval-cold.js";
import { readRubric } from "../eval-evidence.js";
import type { JudgeConfig, JudgeHarness } from "../eval-harness.js";
import { runL0, type L0Result } from "../eval-l0.js";
import { paceInput } from "../eval-pace-cli.js";
import type { RewriteReport } from "../rewrite-pass.js";
import { plainWords, ScriptSchema } from "../script-schema.js";
import type { StageRecord } from "./records.js";
import { ChildStageFailure } from "./stage-cache.js";
import type { SampleCase, SampleEnv } from "./samples-measure.js";

/** What grading one script artifact reads beyond its target rows: the L0 rows, the words it speaks and a cold viewer's pass over it. */
export interface ArGrade {
  l0Rows: L0Result[];
  spokenWords: number;
  cold: ColdResult;
}

export interface ArEnv extends SampleEnv {
  grade: (sha: string) => Promise<ArGrade>;
}

interface ArRequest {
  cases: readonly SampleCase[];
  repeats: number;
  /** The first repeat's sample index, so a second arm under the same settings gets cache keys of its own. */
  first?: number;
  rung: string;
  /** Stops before a run the dearest run so far says would take the total spend past it. */
  maxUsd?: number;
  /** What an earlier arm under the same cap already spent and its dearest run; both count toward the cap and the estimate. */
  prior?: Pick<ArOutcome, "spentUsd" | "dearestUsd">;
}

export interface ArOutcome {
  lines: ArResult[];
  /** One message per run that made no script, so no line. */
  failed: string[];
  spentUsd: number;
  dearestUsd: number;
  stopped?: string;
}

/** Grades a script/v1 text with every L0 check and one cold pass over its planned beat durations (no TTS has run). */
export async function gradeScript(text: string, sha: string, judge: JudgeConfig, harness: JudgeHarness): Promise<ArGrade> {
  const raw: unknown = JSON.parse(text);
  const script = ScriptSchema.parse(raw);
  const { beats, glossary } = paceInput(raw, "v1", undefined);
  const assertions = Object.fromEntries(script.beats.map((beat) => [beat.id, beat.visual.assertion]));
  const cold = await runCold({ scriptSha: sha, beats, glossary, assertions, rubric: readRubric("l1-cold.md"), judge, harness, run: 1 });
  const spokenWords = script.beats.reduce((total, beat) => total + plainWords(beat.spoken).length, 0);
  return { l0Rows: runL0(script), spokenWords, cold };
}

const errorText =(error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A failed gate still leaves its record and its script, which is what the line's gate and violation counts report. */
async function recordOf(env: ArEnv, inputs: SampleCase["inputs"], sample: number): Promise<{ record?: StageRecord; error?: string }> {
  try {
    return { record: await env.run(inputs, sample) };
  } catch (error) {
    if (error instanceof ChildStageFailure && error.record) return { record: error.record, error: errorText(error) };
    return { error: errorText(error) };
  }
}

/** The script stage has no rewrite pass, so the report holds only the script's own target rows and no rejections. */
const reportOf = (after: RewriteReport["after"]): RewriteReport => ({ judge: "", before: [], after, rounds: [], calls: [], usd: 0, tokensIn: 0, tokensOut: 0 });

async function lineFor(request: ArRequest, env: ArEnv, c: SampleCase, repeat: number): Promise<{ line?: ArResult; usd: number; error?: string }> {
  const { record, error } = await recordOf(env, c.inputs, repeat);
  const usd = record?.cached ? 0 : (record?.usage.usd ?? 0);
  const sha = record?.outputs.draft;
  if (record === undefined || sha === undefined) return { usd, error: error ?? "stage script made no draft" };
  try {
    const graded = await env.grade(sha);
    const spent = usd + graded.cold.spend.usd;
    const rewrite = { report: reportOf(env.score(sha)), spokenWords: graded.spokenWords };
    const line = arResultFor({ case: c.name, repeat: `r${repeat + 1}`, rung: request.rung, l0Rows: graded.l0Rows, cold: graded.cold, rewrite, usd: spent, wallS: record.wallMs / 1000 });
    return { line, usd: spent };
  } catch (gradeError) {
    return { usd, error: `grading ${sha.slice(0, 12)}: ${errorText(gradeError)}` };
  }
}

/** Runs the script stage per case and repeat, repeat-major, and maps each script to one ar-result/v2 line. */
export async function runArResults(request: ArRequest, env: ArEnv): Promise<ArOutcome> {
  const outcome: ArOutcome = { lines: [], failed: [], spentUsd: 0, dearestUsd: 0 };
  const first = request.first ?? 0;
  for (let repeat = first; repeat < first + request.repeats; repeat++) {
    for (const c of request.cases) {
      const spent = (request.prior?.spentUsd ?? 0) + outcome.spentUsd;
      const dearest = Math.max(request.prior?.dearestUsd ?? 0, outcome.dearestUsd);
      if (request.maxUsd !== undefined && spent + dearest > request.maxUsd) {
        return { ...outcome, stopped: `spend cap: $${spent.toFixed(4)} spent, the next run (est. $${dearest.toFixed(4)}) would pass $${request.maxUsd}` };
      }
      const { line, usd, error } = await lineFor(request, env, c, repeat);
      outcome.spentUsd += usd;
      outcome.dearestUsd = Math.max(outcome.dearestUsd, usd);
      if (line) outcome.lines.push(line);
      else outcome.failed.push(`${c.name} r${repeat + 1}: ${error}`);
    }
  }
  return outcome;
}
