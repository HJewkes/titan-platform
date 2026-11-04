import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REWRITE_TARGET_ROWS } from "./rewrite-plan.js";
import { summarizeMeasure, type MeasureInput } from "./rewrite-measure.js";
import { compareArms, NOISE_SIGMAS, type NoiseFloor, type RowCompare } from "./workflow/samples-compare.js";
import { STAGE_VERSIONS } from "./workflow/stage-spec.js";
import { runSamples, sampleRange, type SampleCase, type SampledStage, type SampleEnv, type SampleResult } from "./workflow/samples-measure.js";

export const AaFloorSchema = z.object({
  schema: z.literal("explainer.aa-floor/v1"),
  stage: z.enum(["script", "rewrite"]),
  /** The stage body's version: a floor measured on an older body says nothing about a newer one. */
  stageVersion: z.string(),
  measuredAt: z.string(),
  cases: z.array(z.string()),
  samplesPerArm: z.number().int().positive(),
  /** One sample's noise per target row, pooled over the cases and both arms. */
  sigma: z.partialRecord(z.enum(REWRITE_TARGET_ROWS), z.number()),
  /** The second arm against the first, judged on `sigma`: a sound floor calls every row noise. */
  rows: z.array(z.custom<RowCompare>()),
  spentUsd: z.number(),
  runs: z.number(),
  failedRuns: z.number(),
  stopped: z.string().optional(),
});
export type AaFloor = z.infer<typeof AaFloorSchema>;

export interface AaFloorRequest {
  stage: SampledStage;
  cases: readonly SampleCase[];
  samplesPerArm: number;
  maxUsd?: number;
  now: () => Date;
}

const armed = (inputs: readonly MeasureInput[], arm: string): MeasureInput[] => inputs.map((input) => ({ ...input, name: `${input.name}/${arm}` }));

/** σ per row pooled within each arm, never across them, so the floor is the noise of one arm's samples. */
export function floorSigma(a: readonly MeasureInput[], b: readonly MeasureInput[]): NoiseFloor {
  const rows = summarizeMeasure([...armed(a, "a"), ...armed(b, "b")]).rows;
  return Object.fromEntries(rows.flatMap((row) => (row.sigma === undefined ? [] : [[row.row, row.sigma]])));
}

function floorOf(request: AaFloorRequest, a: SampleResult, b: SampleResult): AaFloor {
  const sigma = floorSigma(a.inputs, b.inputs);
  const runs = [...a.runs, ...b.runs];
  const stopped = a.stopped ?? b.stopped;
  return {
    schema: "explainer.aa-floor/v1", stage: request.stage, stageVersion: STAGE_VERSIONS[request.stage], measuredAt: request.now().toISOString(), cases: request.cases.map((c) => c.name),
    samplesPerArm: request.samplesPerArm, sigma, rows: compareArms(summarizeMeasure(a.inputs), summarizeMeasure(b.inputs), sigma),
    spentUsd: a.spentUsd + b.spentUsd, runs: runs.length, failedRuns: runs.filter((run) => run.error).length, ...(stopped ? { stopped } : {}),
  };
}

/**
 * The champion against itself: arm A takes sample indices 0 to n-1 and arm B n to 2n-1, so the two arms are distinct
 * cached runs of the same settings. One spend cap covers both arms.
 */
export async function measureAaFloor(request: AaFloorRequest, env: SampleEnv): Promise<AaFloor> {
  const n = request.samplesPerArm;
  const arm = { stage: request.stage, cases: request.cases, ...(request.maxUsd === undefined ? {} : { maxUsd: request.maxUsd }) };
  const a = await runSamples({ ...arm, samples: sampleRange(0, n) }, env);
  const b = a.stopped ? { ...a, inputs: [], runs: [], spentUsd: 0 } : await runSamples({ ...arm, samples: sampleRange(n, n), prior: a.runs }, env);
  return floorOf(request, a, b);
}

export const NOTES_START = "<!-- aa-floor:start -->";
export const NOTES_END = "<!-- aa-floor:end -->";
const num = (value: number | undefined): string => (value === undefined ? "n/a" : value.toFixed(3));

/** The floor as the stage unit's notes section, between markers so a new measure replaces it. */
export function floorSection(floor: AaFloor): string {
  const rows = floor.rows.map((row) => {
    const sigma = floor.sigma[row.row];
    return `| ${row.row} | ${num(sigma)} | ± ${num(sigma === undefined ? undefined : NOISE_SIGMAS * sigma)} | ${row.diff >= 0 ? "+" : ""}${num(row.diff)} | ${row.verdict} |`;
  });
  return [
    NOTES_START,
    `## A/A noise floor (${floor.stage}, stage version ${floor.stageVersion})`,
    "",
    `Measured ${floor.measuredAt.slice(0, 10)} by \`explainer aa-floor\`: the champion against itself, ${floor.samplesPerArm} samples per arm over ` +
      `${floor.cases.length} cases (${floor.cases.join(", ")}); ${floor.runs} runs, ${floor.failedRuns} failed, $${floor.spentUsd.toFixed(2)}.` +
      `${floor.stopped ? ` Stopped early: ${floor.stopped}.` : ""}`,
    `σ is one sample's noise per row, pooled over cases and arms. \`explainer ab\` calls a difference within ${NOISE_SIGMAS}σ noise.`,
    "",
    "| row | σ (one sample) | 2σ band | A/A diff | A/A verdict |",
    "|---|---|---|---|---|",
    ...rows,
    NOTES_END,
  ].join("\n");
}

/** Writes `notes.md` and `aa-floor.json` into the stage unit's directory; the notes keep any text outside the markers. */
export function writeFloorNotes(unitDir: string, floor: AaFloor): void {
  const notes = path.join(unitDir, "notes.md");
  const old = existsSync(notes) ? readFileSync(notes, "utf8") : `# ${path.basename(unitDir)} notes\n`;
  const start = old.indexOf(NOTES_START);
  const end = old.indexOf(NOTES_END);
  const next = start >= 0 && end > start ? `${old.slice(0, start)}${floorSection(floor)}${old.slice(end + NOTES_END.length)}` : `${old.trimEnd()}\n\n${floorSection(floor)}\n`;
  writeFileSync(notes, next);
  writeFileSync(path.join(unitDir, "aa-floor.json"), `${JSON.stringify(floor, null, 2)}\n`);
}

/** Reads a floor from its JSON file, or from a stage unit directory holding `aa-floor.json`. */
export function readFloor(target: string): AaFloor {
  const file = statSync(target).isDirectory() ? path.join(target, "aa-floor.json") : target;
  return AaFloorSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
