import { cueResolverFromWords } from "../cues.js";
import { failedChecks, runL0, type L0Check, type L0Result } from "../eval-l0.js";
import { paceRows } from "../lint-pace.js";
import { fromScriptV1 } from "../pace-items.js";
import type { RewriteReport } from "../rewrite-pass.js";
import { beatCues, ScriptSchema, type ScriptV1 } from "../script-schema.js";
import { parseSpine } from "../spine-schema.js";
import { readTiming } from "../timing.js";
import type { ArtifactStore } from "./artifacts.js";
import type { CachedStage, Check } from "./records.js";

/** What a check reads: the stage's input and output shas, by artifact name. */
export interface CheckInput {
  artifacts: Readonly<Record<string, string>>;
  store: Pick<ArtifactStore, "readText">;
  l0Checks: readonly L0Check[];
}

type Verdict = Pick<Check, "pass" | "detail">;

/**
 * One deterministic check from the workflow plan's §5.1 table. A `gate` fails its stage; any other check is
 * reported only. A check whose artifacts the stage did not produce is skipped with a note, never failed.
 */
export interface StageCheck {
  name: string;
  gate: boolean;
  reads: readonly string[];
  run: (input: CheckInput) => Verdict;
}

const text = (input: CheckInput, name: string): string => input.store.readText(input.artifacts[name]!);
const script = (input: CheckInput, name: string): ScriptV1 => ScriptSchema.parse(JSON.parse(text(input, name)));

const errorRows = (rows: readonly L0Result[]) => rows.filter((row) => row.severity === "error");
const warningRows = (rows: readonly L0Result[]) => rows.filter((row) => row.severity === "warning");

function rowsVerdict(rows: readonly L0Result[]): Verdict {
  const failed = failedChecks(rows);
  return { pass: failed.length === 0, detail: `${rows.length} rows; failed: ${failed.join(", ") || "none"}` };
}

const l0Draft = (input: CheckInput): L0Result[] =>
  runL0(script(input, "draft"), undefined, input.l0Checks, undefined, parseSpine(text(input, "spine")));

const paceVerdict = (name: string) => (input: CheckInput): Verdict => {
  const draft = script(input, name);
  return rowsVerdict(errorRows(paceRows(fromScriptV1(draft), draft.video.invariants ?? [])));
};

/** Error rows that fail on the rewritten script but passed on the draft: the rewrite made the script worse. */
function noNewL0Error(input: CheckInput): Verdict {
  const failing = (rows: readonly L0Result[]) => new Set(errorRows(rows).filter((row) => !row.pass).map((row) => row.check_id));
  const before = failing(runL0(script(input, "draft"), undefined, input.l0Checks));
  const added = [...failing(runL0(script(input, "script"), undefined, input.l0Checks))].filter((id) => !before.has(id));
  return { pass: added.length === 0, detail: `new failing error rows: ${added.join(", ") || "none"}` };
}

function rewriteTargetRows(input: CheckInput): Verdict {
  const report = JSON.parse(text(input, "rewrite-report")) as Pick<RewriteReport, "after">;
  const red = report.after.filter((row) => !row.pass).map((row) => row.check_id);
  return { pass: red.length === 0, detail: `${red.length} of ${report.after.length} target rows red${red.length ? `: ${red.join(", ")}` : ""}` };
}

/** Every cue the script names lands on a word the voice actually spoke, so no visual fires on a guess. */
function cueResolution(input: CheckInput): Verdict {
  const timing = readTiming(JSON.parse(text(input, "words")));
  const words = Object.fromEntries([...timing].map(([id, beat]) => [id, beat.words ?? []]));
  const resolve = cueResolverFromWords(words);
  const missed: string[] = [];
  let total = 0;
  for (const beat of script(input, "script").beats) {
    for (const cue of beatCues(beat.visual)) {
      total++;
      try {
        resolve(beat.id, cue);
      } catch {
        missed.push(`${beat.id}:${cue}`);
      }
    }
  }
  const shown = missed.slice(0, 5).join(", ") + (missed.length > 5 ? ` and ${missed.length - 5} more` : "");
  return { pass: missed.length === 0, detail: `${total - missed.length} of ${total} cues resolve${missed.length ? `; unresolved: ${shown}` : ""}` };
}

/**
 * Each in-process stage's §5.1 deterministic checks, run as the `checks:<stage>` step after its body. The eval stage
 * gates inside its body, before the reported-only judge spends; a bridged stage's other §5.1 checks are the
 * `check` commands of its `bridge.json` block until its TypeScript port lands.
 */
export const STAGE_CHECKS: Record<CachedStage, readonly StageCheck[]> = {
  script: [
    { name: "l0", gate: true, reads: ["draft", "spine"], run: (input) => rowsVerdict(errorRows(l0Draft(input))) },
    { name: "l0-warnings", gate: false, reads: ["draft", "spine"], run: (input) => rowsVerdict(warningRows(l0Draft(input))) },
    { name: "pace", gate: true, reads: ["draft"], run: paceVerdict("draft") },
  ],
  rewrite: [
    { name: "no-new-l0-error", gate: true, reads: ["draft", "script"], run: noNewL0Error },
    { name: "rewrite-rows", gate: false, reads: ["rewrite-report"], run: rewriteTargetRows },
  ],
  eval: [],
  tts: [{ name: "cue-resolution", gate: true, reads: ["script", "words"], run: cueResolution }],
  render: [],
  qa: [],
  sheets: [],
};

export interface CheckRun {
  checks: Check[];
  notes: string[];
}

/** Runs a stage's checks over its artifacts. A check that throws fails with the error as its detail. */
export function runStageChecks(stage: CachedStage, input: CheckInput, checks: readonly StageCheck[] = STAGE_CHECKS[stage]): CheckRun {
  const out: CheckRun = { checks: [], notes: [] };
  for (const check of checks) {
    const missing = check.reads.filter((name) => input.artifacts[name] === undefined);
    if (missing.length > 0) {
      out.notes.push(`check ${check.name} skipped: no ${missing.join(", ")} artifact`);
      continue;
    }
    let verdict: Verdict;
    try {
      verdict = check.run(input);
    } catch (error) {
      verdict = { pass: false, detail: `could not run: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200)}` };
    }
    out.checks.push({ name: check.name, gate: check.gate, ...verdict });
  }
  return out;
}

/** The gate checks that failed; any one fails the stage. */
export const failedGates = (checks: readonly Check[]): Check[] => checks.filter((check) => check.gate === true && !check.pass);
