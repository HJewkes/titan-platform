import { z } from "zod";
import { loadBeatSpecs } from "../beat-load.js";
import { claimFacts, withClaimFacts } from "../claim-facts.js";
import { parseCoverage, withCoverage } from "../lint-coverage.js";
import { cueResolverFromWords } from "../cues.js";
import type { JudgeConfig, JudgeHarness } from "../eval-harness.js";
import { failedChecks, runL0, type L0Check, type L0Result } from "../eval-l0.js";
import { emphasisGateVerdict } from "../emphasis-gate.js";
import { paceRows } from "../lint-pace.js";
import { fromScriptV1 } from "../pace-items.js";
import { beatCues, ScriptSchema, type ScriptV1 } from "../script-schema.js";
import { spellScript } from "../rewrite-pass.js";
import { keptBeats, readEmphasisInput, ResolvedSchema, simCheckVerdict, simCutOrphanVerdict, slotOverridesVerdict, wordBudgetVerdict } from "../resolve-stage.js";
import { draftBeatLengths, draftRuntime, draftWordBudget } from "../script-budget.js";
import { parseSpine } from "../spine-schema.js";
import { labelConventionsVerdict } from "../label-conventions.js";
import { leadBeats, uncuedTargets } from "../lead-beats.js";
import { listenerQuestionsCheck } from "../listener-check.js";
import { readTiming } from "../timing.js";
import { unknownWords } from "../unknown-words.js";
import { doctrineG2p } from "./voice-g2p.js";
import type { ArtifactStore } from "./artifacts.js";
import { addUsage, NO_USAGE, type CachedStage, type Check, type StageUsage } from "./records.js";

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
interface StageCheck {
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

/** The L0 checks, with Q-E20 and Q-E22 reading the stage's gathered facts, and Q-E21 its coverage manifest, when it has them. */
function l0With(input: CheckInput): readonly L0Check[] {
  const facts = input.artifacts.facts === undefined ? undefined : claimFacts(text(input, "facts"));
  const coverage = input.artifacts.coverage === undefined ? undefined : parseCoverage(text(input, "coverage"));
  return withCoverage(withClaimFacts(input.l0Checks, facts), coverage, facts);
}

const l0Draft = (input: CheckInput): L0Result[] =>
  runL0(script(input, "draft"), undefined, l0With(input), undefined, parseSpine(text(input, "spine")));

const paceVerdict = (name: string) => (input: CheckInput): Verdict => {
  const draft = script(input, name);
  return rowsVerdict(errorRows(paceRows(fromScriptV1(draft), draft.video.invariants ?? [])));
};

/** Error rows that fail on the rewritten script but passed on the draft: the rewrite made the script worse. */
function noNewL0Error(input: CheckInput): Verdict {
  const failing = (rows: readonly L0Result[]) => new Set(errorRows(rows).filter((row) => !row.pass).map((row) => row.check_id));
  const checks = l0With(input);
  const before = failing(runL0(spellScript(script(input, "draft")), undefined, checks));
  const added = [...failing(runL0(script(input, "script"), undefined, checks))].filter((id) => !before.has(id));
  return { pass: added.length === 0, detail: `new failing error rows: ${added.join(", ") || "none"}` };
}

const TargetRowsSchema = z.object({ after: z.array(z.object({ check_id: z.string(), pass: z.boolean() })) });

function rewriteTargetRows(input: CheckInput): Verdict {
  const report = TargetRowsSchema.parse(JSON.parse(text(input, "rewrite-report")));
  const red = report.after.filter((row) => !row.pass).map((row) => row.check_id);
  return { pass: red.length === 0, detail: `${red.length} of ${report.after.length} target rows red${red.length ? `: ${red.join(", ")}` : ""}` };
}

const shownList = (items: readonly string[]): string => items.slice(0, 5).join(", ") + (items.length > 5 ? ` and ${items.length - 5} more` : "");

/** Every emphasis target the draft's beat specs declare has a cue to land on, so the render never holds a static frame. */
function cuesPresent(input: CheckInput): Verdict {
  const specs = loadBeatSpecs();
  const uncued = uncuedTargets(script(input, "draft"), leadBeats(parseSpine(text(input, "spine")), specs), specs);
  return { pass: uncued.length === 0, detail: uncued.length === 0 ? "every emphasis target has a cue" : `uncued: ${shownList(uncued)}` };
}

/**
 * Every word of the spelled draft has phonemes in the voice's g2p, the doctrine lexicon included, so a word the voice
 * cannot say fails here, before the rewrite and tts spend, rather than at tts (owner, TP-3032 s7 item 9).
 */
function knownWords(input: CheckInput): Verdict {
  const unknown = unknownWords(doctrineG2p(), spellScript(script(input, "draft")));
  const named = [...new Set(unknown.map(({ beat, word }) => `${word} (${beat})`))];
  return { pass: unknown.length === 0, detail: unknown.length === 0 ? "every spoken word has phonemes" : `no phonemes for: ${shownList(named)}` };
}

/** Beats whose beat spec declares emphasis targets: with any, a script of no cues has nothing to resolve and fails. */
function cuedBeats(beats: ScriptV1["beats"]): number {
  const specs = loadBeatSpecs();
  return beats.filter(({ visual }) => (specs.get(visual.beat ?? "")?.emphasis?.targets.length ?? 0) > 0).length;
}

/** Every cue the script names lands on a word the voice actually spoke, so no visual fires on a guess. */
/** The script beats tts voiced: those resolve kept, once the run has a `resolved` artifact. */
function voicedScriptBeats(input: CheckInput): ScriptV1["beats"] {
  const { beats } = script(input, "script");
  return input.artifacts.resolved === undefined ? beats : keptBeats(beats, ResolvedSchema.parse(JSON.parse(text(input, "resolved"))));
}

function cueResolution(input: CheckInput): Verdict {
  const timing = readTiming(JSON.parse(text(input, "words")));
  const words = Object.fromEntries([...timing].map(([id, beat]) => [id, beat.words ?? []]));
  const resolve = cueResolverFromWords(words);
  const missed: string[] = [];
  let total = 0;
  const beats = voicedScriptBeats(input);
  for (const beat of beats) {
    for (const cue of beatCues(beat.visual)) {
      total++;
      try {
        resolve(beat.id, cue);
      } catch {
        missed.push(`${beat.id}:${cue}`);
      }
    }
  }
  const targeted = total === 0 ? cuedBeats(beats) : 0;
  if (targeted > 0) return { pass: false, detail: `0 cues, but ${targeted} beats name a beat spec with emphasis targets` };
  return { pass: missed.length === 0, detail: `${total - missed.length} of ${total} cues resolve${missed.length ? `; unresolved: ${shownList(missed)}` : ""}` };
}

/**
 * Each in-process stage's §5.1 deterministic checks, run as the `checks:<stage>` step after its body. The eval stage
 * gates inside its body, before the reported-only judge spends; a bridged stage's other §5.1 checks are the
 * `check` commands of its `bridge.json` block until its TypeScript port lands.
 */
export const STAGE_CHECKS: Record<CachedStage, readonly StageCheck[]> = {
  gather: [],
  audition: [],
  script: [
    { name: "l0", gate: true, reads: ["draft", "spine"], run: (input) => rowsVerdict(errorRows(l0Draft(input))) },
    { name: "l0-warnings", gate: false, reads: ["draft", "spine"], run: (input) => rowsVerdict(warningRows(l0Draft(input))) },
    { name: "pace", gate: true, reads: ["draft"], run: paceVerdict("draft") },
    { name: "cues-present", gate: true, reads: ["draft", "spine"], run: cuesPresent },
    { name: "unknown-words", gate: true, reads: ["draft"], run: knownWords },
    { name: "word-budget", gate: true, reads: ["draft"], run: (input) => draftWordBudget(script(input, "draft")) },
    { name: "runtime", gate: true, reads: ["draft"], run: (input) => draftRuntime(script(input, "draft")) },
    { name: "beat-length", gate: true, reads: ["draft"], run: (input) => draftBeatLengths(script(input, "draft")) },
    { name: "label-conventions", gate: false, reads: ["draft"], run: (input) => labelConventionsVerdict(script(input, "draft")) },
  ],
  rewrite: [
    { name: "no-new-l0-error", gate: true, reads: ["draft", "script"], run: noNewL0Error },
    { name: "rewrite-rows", gate: false, reads: ["rewrite-report"], run: rewriteTargetRows },
  ],
  eval: [],
  resolve: [
    { name: "emphasis-target", gate: true, reads: ["script", "resolved", "slots"], run: (input) => emphasisGateVerdict(readEmphasisInput(input)) },
    { name: "word-budget", gate: true, reads: ["resolved"], run: wordBudgetVerdict },
    { name: "slot-overrides", gate: true, reads: ["script", "resolved"], run: slotOverridesVerdict },
    { name: "sim-check", gate: false, reads: ["sim-traces"], run: simCheckVerdict },
    { name: "sim-cut-orphan", gate: true, reads: ["script", "resolved"], run: simCutOrphanVerdict },
  ],
  tts: [{ name: "cue-resolution", gate: true, reads: ["script", "words"], run: cueResolution }],
  render: [],
  qa: [],
  sheets: [],
};

const couldNotRun = (error: unknown): Verdict => ({
  pass: false,
  detail: `could not run: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200)}`,
});

interface CheckRun {
  checks: Check[];
  notes: string[];
}

/** The judge a model-backed check calls; a run that names none skips those checks. */
export interface CheckJudge {
  config: JudgeConfig;
  harness: JudgeHarness;
  /** Questions a sentence above which `listener-questions` reports red; none by default. */
  listenerThreshold?: number;
}

/** A check that spends on a model call. It is always reported, never a gate, until owner labels calibrate it. */
export interface JudgedStageCheck {
  name: string;
  reads: readonly string[];
  run: (input: CheckInput, judge: CheckJudge) => Promise<Verdict & { usage: StageUsage }>;
}

const JUDGED_CHECKS: Partial<Record<CachedStage, readonly JudgedStageCheck[]>> = {
  script: [listenerQuestionsCheck],
};

/** Runs a stage's judged checks after its deterministic ones; their spend is the checks step's own. */
export async function runJudgedChecks(
  stage: CachedStage, input: CheckInput, judge: CheckJudge | undefined, checks: readonly JudgedStageCheck[] = JUDGED_CHECKS[stage] ?? [],
): Promise<CheckRun & { usage: StageUsage }> {
  const out = { checks: [] as Check[], notes: [] as string[], usage: NO_USAGE };
  if (!judge) return out;
  for (const check of checks) {
    const missing = check.reads.filter((name) => input.artifacts[name] === undefined);
    if (missing.length > 0) {
      out.notes.push(`check ${check.name} skipped: no ${missing.join(", ")} artifact`);
      continue;
    }
    try {
      const { usage, ...verdict } = await check.run(input, judge);
      out.usage = addUsage(out.usage, usage);
      out.checks.push({ name: check.name, gate: false, ...verdict });
    } catch (error) {
      out.checks.push({ name: check.name, gate: false, ...couldNotRun(error) });
    }
  }
  return out;
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
      verdict = couldNotRun(error);
    }
    out.checks.push({ name: check.name, gate: check.gate, ...verdict });
  }
  return out;
}

/** The gate checks that failed; any one fails the stage. */
export const failedGates = (checks: readonly Check[]): Check[] => checks.filter((check) => check.gate === true && !check.pass);
