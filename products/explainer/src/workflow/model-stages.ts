import { tmpdir } from "node:os";
import { agentRunner, type AgentRunnerOptions, type LegacyStepRunner } from "@titan-design/workflow";
import { L0_CHECKS, l0HardPass, failedChecks, runL0, type L0Check, type L0Result } from "../eval-l0.js";
import { readColdRubric, rubricBeatsFromPace, rubricNote, runColdRubric } from "../eval-cold-rubric.js";
import { createJudgeHarness, type JudgeConfig, type JudgeHarness } from "../eval-harness.js";
import { canonicalSha } from "../eval-store.js";
import { claimFacts, withClaimFacts } from "../claim-facts.js";
import { stampLedgerTerms, type Stamped } from "../ledger-stamp.js";
import { parseCoverage, withCoverage, type CoverageManifest } from "../lint-coverage.js";
import { paceRows } from "../lint-pace.js";
import { fromScriptV1 } from "../pace-items.js";
import { rewriteScript, spellScript } from "../rewrite-pass.js";
import { parseScript } from "../script-load.js";
import { fillRows } from "../script-fill.js";
import type { ScriptV1 } from "../script-schema.js";
import { parseSpine, type SpineV1 } from "../spine-schema.js";
import { unknownWordsRow, type Tokens } from "../unknown-words.js";
import { COMPANION_FILE, companionChapters, renderCompanion, reviewFacts, type ChapterLinks } from "../presets/repo-explainer/companion.js";
import type { ArtifactStore, Provenance } from "./artifacts.js";
import { loadRuleRegistry } from "../rules.js";
import { chunkedScript, isChunked } from "./script-chunks.js";
import {
  callsNote, checked, draftScript, failingErrors, failureList, planned, promptSections, REPLY_RULES, repairPrompt, repairRounds, retimeRepaired, scriptPlan,
  sharedSections, stageUsage, wholeScript,
  type Call, type CallSpend, type Lint, type Repaired, type ScriptPlan, type Written,
} from "./script-draft.js";
import { hinted, keptOverSeed, splitStart } from "./split-start.js";
import { StageFailure } from "./stage-failure.js";
import { stampCheck } from "./stamp-check.js";
import { addUsage, NO_USAGE, type Check, type StageOutcome, type StageUsage } from "./records.js";
import { doctrineG2p } from "./voice-g2p.js";

export { stageUsage } from "./script-draft.js";
export { StageFailure } from "./stage-failure.js";

export type RunnerFor = (options: AgentRunnerOptions) => LegacyStepRunner;
export type HarnessFor = (config: JudgeConfig) => JudgeHarness;

/** One script call's own ceiling; the run's cap also bounds it through `remainingUsd`. */
export const SCRIPT_CALL_USD = 4;

export interface ModelStageInput {
  artifacts: Readonly<Record<string, string>>;
  store: Pick<ArtifactStore, "readText" | "putText">;
  from: Provenance;
  remainingUsd: number;
}

const need = (input: ModelStageInput, name: string): string => {
  const sha = input.artifacts[name];
  if (sha === undefined) throw new Error(`stage ${input.from.stage} needs artifact "${name}", which no earlier stage produced`);
  return sha;
};

const readScript = (input: ModelStageInput, name: string): ScriptV1 => parseScript(JSON.parse(input.store.readText(need(input, name))));
const putJson = (input: ModelStageInput, value: unknown, kind: string): string => input.store.putText(`${JSON.stringify(value, null, 2)}\n`, kind, input.from);

const SCRIPT_TASK = `## Task

Write the whole script/v1 for this video as one JSON object, and reply with that object only.
- Keep every chapter id and beat id, in the order the spine's beat plan lists them, with its function and plannedS.
${REPLY_RULES}`;

const promptFor = (sections: readonly string[]): string => [...sections, SCRIPT_TASK].join("\n\n") + "\n";

/** The script call's prompt: the guide in the spine's structure, the spine, the facts and each chapter's lead beat spec. */
export function scriptPrompt(spine: string, facts: string): string {
  return promptFor(promptSections(spine, facts, scriptPlan(parseSpine(spine))));
}

export interface ScriptStageDeps {
  model: string;
  /** The run's video type, stamped on the script; a run with no profile keeps the reply's, checked against the registry. */
  profile?: string;
  runnerFor?: RunnerFor;
  /** The L0 checks the repair call answers; all of them by default. */
  l0Checks?: readonly L0Check[];
  /** The g2p the repair's unknown-words row reads; the doctrine voice's by default. */
  g2p?: Tokens;
  signal?: AbortSignal;
}

interface Repair extends Repaired {
  check: Check;
  /** Each round's failure list as sent, hints and the split's line included. */
  hints: string[];
}

/** A repair answers a few rows at a time well; measured on one video, one round left half of the error rows red. */
export const MAX_REPAIR_ROUNDS = 2;

/**
 * Up to `MAX_REPAIR_ROUNDS` calls, each answering the current script's failing error-severity L0 rows. A reply is
 * kept only when it parses and fails fewer rows, so a round never makes the script worse.
 */
async function repairScript(call: Call, prompt: string, plan: ScriptPlan, draft: Stamped, lint: Lint): Promise<Repair | undefined> {
  const failing = (script: ScriptV1) => [...failingErrors(lint.rows(script)), ...fillRows(script)];
  const seedRows = failing(draft.script).length;
  if (seedRows === 0) return undefined;
  const settle = (script: ScriptV1) => stampLedgerTerms(script, lint.spine, lint.rows);
  const start = splitStart(draft, failing, settle);
  const rules = loadRuleRegistry();
  const hints: string[] = [];
  const repaired = await repairRounds(call, start.stamped, {
    rounds: MAX_REPAIR_ROUNDS,
    failing,
    prompt: (script, rows) => repairPrompt(prompt, script, hinted(hints, failureList(rows, rules, script, lint), start.hint)),
    read: (outcome) => checked(outcome, plan),
    settle,
  });
  const kept = keptOverSeed(repaired, draft, seedRows);
  const detail = `${kept.before} failing error checks before repair, ${kept.after} after`;
  return { ...kept, candidates: [...start.candidates, ...kept.candidates], hints, check: { name: "l0-repair", gate: false, pass: kept.after === 0, detail } };
}

const SHOWN_KEYS = 10;

/** Reported only: the kept script parsed once these keys were dropped, so a reader sees what the model added. */
function unknownKeysCheck(stripped: readonly string[]): Check[] {
  if (stripped.length === 0) return [];
  const shown = stripped.slice(0, SHOWN_KEYS).join(", ") + (stripped.length > SHOWN_KEYS ? ` and ${stripped.length - SHOWN_KEYS} more` : "");
  return [{ name: "script-unknown-keys", gate: false, pass: false, detail: `dropped ${stripped.length} key(s) the schema does not allow: ${shown}` }];
}

/** A script the stage holds before any repair: the drafted reply, or a stored seed, with what it cost to get. */
interface Drafted {
  stamped: Stamped;
  usage: StageUsage;
  retries: number;
  stripped: readonly string[];
  dropped: readonly string[];
  retimed: readonly string[];
}

/** The half a drafted script and a seeded one share: the L0 repair rounds, then the re-time. */
async function repairedDraft(call: Call, prompt: string, plan: ScriptPlan, lint: Lint, drafted: Drafted): Promise<Written> {
  const repair = await repairScript(call, prompt, plan, drafted.stamped, lint);
  const retimed = retimeRepaired(repair?.script ?? drafted.stamped.script, drafted.retimed);
  return {
    script: retimed.script,
    stamps: repair?.stamps ?? drafted.stamped.stamps,
    usage: repair ? addUsage(drafted.usage, repair.usage) : drafted.usage,
    retries: drafted.retries,
    stripped: repair?.stripped ?? [...drafted.stripped],
    checks: [...(repair ? [repair.check] : []), ...retimed.checks],
    notes: [...(repair?.dropped ?? drafted.dropped), ...retimed.notes],
    ...(repair && repair.after > 0 ? { tried: { candidates: repair.candidates, hints: repair.hints } } : {}),
  };
}

/** The single-call path: one draft call and its one retry, the ledger stamp, then the L0 repair rounds. */
async function wholeDraft(call: Call, prompt: string, plan: ScriptPlan, lint: Lint): Promise<Written> {
  const draft = await draftScript(call, prompt, wholeScript(plan));
  const retries = draft.retried ? 1 : 0;
  if (!draft.script) throw new StageFailure(`script: ${draft.error}`, draft.usage, retries);
  const stamped = stampLedgerTerms(draft.script, lint.spine, lint.rows);
  return repairedDraft(call, prompt, plan, lint, { stamped, usage: draft.usage, retries, stripped: draft.stripped ?? [], dropped: draft.dropped ?? [], retimed: draft.retimed });
}

/**
 * A stored draft in place of the draft call and its plan retry, so a resume pays only for the repair rounds its failing
 * rows need. Its own name, not `draft`, keeps a base whose plan holds a draft from turning a later run into a resume.
 */
async function seededDraft(call: Call, prompt: string, plan: ScriptPlan, lint: Lint, seed: ScriptV1): Promise<Written> {
  const stamped = stampLedgerTerms(planned(seed, plan), lint.spine, lint.rows);
  return repairedDraft(call, prompt, plan, lint, { stamped, usage: NO_USAGE, retries: 0, stripped: [], dropped: [], retimed: [] });
}

/** Each call's kind and spend, kept in `calls` for the stage's per-call note. */
function recorded(call: Call, calls: CallSpend[]): Call {
  return async (prompt, kind = "call") => {
    const outcome = await call(prompt, kind);
    calls.push({ kind, usage: stageUsage(outcome.usage) });
    return outcome;
  };
}

/** With `system`, the CLI sends it as its own system prompt block and caches it, so calls sharing it read it back. */
function scriptCall(input: ModelStageInput, deps: ScriptStageDeps, system?: string): Call {
  const maxBudgetUsd = Math.max(0.01, Math.min(SCRIPT_CALL_USD, input.remainingUsd));
  const defaults = { harness: "claude-print" as const, model: deps.model, ...(system === undefined ? {} : { systemPrompt: system }) };
  const runner = (deps.runnerFor ?? agentRunner)({ cwd: tmpdir(), maxTurns: 1, maxBudgetUsd, defaults });
  const signal = deps.signal ?? new AbortController().signal;
  return (text) => runner.run({ runId: input.from.runId, workflowName: "explainer-video", stepId: "script", iteration: 0, prompt: text, signal });
}

/** A daily gather's coverage manifest, when the run gathered one. */
const coverageOf = (input: ModelStageInput): CoverageManifest | undefined =>
  input.artifacts.coverage === undefined ? undefined : parseCoverage(input.store.readText(input.artifacts.coverage));

interface ScriptContext {
  spineText: string;
  factsText: string;
  spine: SpineV1;
  plan: ScriptPlan;
  lint: Lint;
  coverage: CoverageManifest | undefined;
  callFor: (system?: string) => Call;
}

/** A seeded run repairs its stored draft; otherwise one call with one retry, or, for a long spine, one chapter per call. */
function writeScript(input: ModelStageInput, ctx: ScriptContext): Promise<Written> {
  const { spineText, factsText, spine, plan, lint, coverage, callFor } = ctx;
  const prompt = promptFor(promptSections(spineText, factsText, plan, coverage));
  if (input.artifacts["seed-draft"] !== undefined) return seededDraft(callFor(), prompt, plan, lint, readScript(input, "seed-draft"));
  if (!isChunked(spine)) return wholeDraft(callFor(), prompt, plan, lint);
  return chunkedScript({ callFor, shared: sharedSections(spineText, plan, coverage), spineText, facts: factsText, plan, lint, capUsd: input.remainingUsd });
}

/** Spine and facts, or a stored seed draft, to a script/v1, then the L0 repair rounds; the notes list each call's spend. */
export async function runScriptStage(input: ModelStageInput, deps: ScriptStageDeps): Promise<StageOutcome> {
  const spineText = input.store.readText(need(input, "spine"));
  const spine = parseSpine(spineText);
  const plan = scriptPlan(spine, deps.profile);
  const factsText = input.store.readText(need(input, "facts"));
  const facts = claimFacts(factsText);
  const coverage = coverageOf(input);
  const l0Checks = withCoverage(withClaimFacts(deps.l0Checks ?? L0_CHECKS, facts), coverage, facts);
  const g2p = deps.g2p ?? doctrineG2p();
  const rows = (script: ScriptV1) => [...runL0(script, undefined, l0Checks, undefined, spine), unknownWordsRow(g2p, spellScript(script))];
  const lint: Lint = { rows, spine, g2p, ...(facts ? { facts } : {}), ...(coverage ? { coverage } : {}) };
  const calls: CallSpend[] = [];
  const callFor = (system?: string) => recorded(scriptCall(input, deps, system), calls);
  const written = await writeScript(input, { spineText, factsText, spine, plan, lint, coverage, callFor });
  const checks: Check[] = [{ name: "script-schema", gate: true, pass: true }, ...unknownKeysCheck(written.stripped), ...stampCheck(written.stamps), ...written.checks];
  const companion = companionOutputs(input, written.script, spine);
  const tried = triedOutputs(input, written.tried);
  const notes = [...(calls.length > 0 ? [callsNote(calls)] : []), ...written.notes, ...tried.notes, ...(companion.notes ?? [])];
  return { outputs: { draft: putJson(input, written.script, "script"), ...tried.outputs, ...companion.outputs }, usage: written.usage, retries: written.retries, checks, notes };
}

/** A repair that left rows failing stores each candidate it tried and notes the failure list each round sent. */
function triedOutputs(input: ModelStageInput, tried: Written["tried"]): Required<Pick<StageOutcome, "outputs" | "notes">> {
  if (!tried) return { outputs: {}, notes: [] };
  const outputs = Object.fromEntries(tried.candidates.map(({ kind, text }) => [`candidate-${kind}`, input.store.putText(text, "script-candidate", input.from)]));
  const stored = Object.entries(outputs).map(([name, sha]) => `${name} ${sha}`);
  const hints = tried.hints.map((hint, i) => `repair-${i + 1} hint:\n${hint}`);
  return { outputs, notes: [...(stored.length > 0 ? [`repair candidates: ${stored.join(", ")}`] : []), ...hints] };
}

/**
 * A repo run's companion doc and chapter links. Written here because the script stage is the first that holds both the
 * gathered facts and the chapters, and the later stages keep every chapter id, so resolve can fill a `companion-link`
 * card from the links. Facts that are not gathered review facts make no companion.
 */
function companionOutputs(input: ModelStageInput, script: ScriptV1, spine: SpineV1): Pick<StageOutcome, "outputs" | "notes"> {
  const facts = reviewFacts(input.store.readText(need(input, "facts")));
  if (facts === undefined) return { outputs: {}, notes: [] };
  const { markdown, links, diagnostics } = renderCompanion(facts, companionChapters(script, spine));
  const companion = input.store.putText(markdown, "companion", input.from);
  const record: ChapterLinks = { schema: "explainer.chapter-links/v1", doc: COMPANION_FILE, docSha: companion, links };
  const notes = [`companion doc ${COMPANION_FILE} links ${links.length} chapters`, ...diagnostics.map((d) => `${d.code} ${d.message}`)];
  return { outputs: { companion, "chapter-links": putJson(input, record, "chapter-links") }, notes };
}

export interface RewriteStageDeps {
  judge: JudgeConfig;
  rounds: number;
  harnessFor?: HarnessFor;
}

/** The register rewrite, in process; its spend is the report's own sum over calls. */
export async function runRewriteStage(input: ModelStageInput, deps: RewriteStageDeps): Promise<StageOutcome> {
  const harness = (deps.harnessFor ?? createJudgeHarness)(deps.judge);
  const { script, report } = await rewriteScript(readScript(input, "draft"), { harness, judge: deps.judge, rounds: deps.rounds });
  const failed = report.calls.filter((call) => !call.ok).length;
  const usage: StageUsage = { usd: report.usd, inputTokens: report.tokensIn, outputTokens: report.tokensOut, cacheReadTokens: 0, calls: report.calls.length };
  return {
    outputs: { script: putJson(input, script, "script"), "rewrite-report": putJson(input, report, "rewrite-report") },
    usage,
    retries: failed,
  };
}

const verdict = (name: string, rows: readonly L0Result[]): Check => ({ name, gate: true, pass: l0HardPass(rows), detail: `${rows.length} checks; failed: ${failedChecks(rows).join(", ") || "none"}` });

export interface EvalStageDeps {
  judge: JudgeConfig;
  harnessFor?: HarnessFor;
}

/**
 * The cold-viewer rows J8 to J12 on the final script. Reported only (owner answer Q5 A): they add a note and an artifact,
 * never a check, so no score and no judge failure can fail the stage.
 */
async function reportColdRubric(input: ModelStageInput, script: ScriptV1, deps: EvalStageDeps): Promise<Pick<StageOutcome, "outputs" | "usage" | "notes">> {
  const beats = rubricBeatsFromPace(fromScriptV1(script));
  const harness = (deps.harnessFor ?? createJudgeHarness)(deps.judge);
  try {
    const result = await runColdRubric({ subjectSha: canonicalSha(script), beats, rubric: readColdRubric(), series: [], judge: deps.judge, harness, run: 1 });
    const usage: StageUsage = { usd: result.spend.usd, inputTokens: result.spend.tokensIn, outputTokens: result.spend.tokensOut, cacheReadTokens: 0, calls: 1 };
    return { outputs: { "cold-rubric": putJson(input, result, "cold-rubric") }, usage, notes: [rubricNote(result)] };
  } catch (error) {
    return { outputs: {}, notes: [`cold rubric (reported only): not scored, ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/**
 * L0 with the spine lints, and pace, on the final script: gates, checked before the reported-only rubric spends. An
 * error-severity failure stops the run here.
 */
export async function runEvalStage(input: ModelStageInput, deps: EvalStageDeps, l0Checks: readonly L0Check[] = L0_CHECKS): Promise<StageOutcome> {
  const script = readScript(input, "script");
  const spine = parseSpine(input.store.readText(need(input, "spine")));
  const facts = input.artifacts.facts === undefined ? undefined : claimFacts(input.store.readText(input.artifacts.facts));
  const l0 = runL0(script, undefined, withCoverage(withClaimFacts(l0Checks, facts), coverageOf(input), facts), undefined, spine);
  const pace = paceRows(fromScriptV1(script), script.video.invariants ?? []);
  const checks = [verdict("l0", l0), verdict("pace", pace)];
  const red = checks.filter((check) => !check.pass);
  if (red.length > 0) throw new StageFailure(`eval: ${red.map((check) => `${check.name} ${check.detail}`).join("; ")}`, NO_USAGE, 0, checks);
  const rubric = await reportColdRubric(input, script, deps);
  return { ...rubric, outputs: { l0: putJson(input, { l0, pace }, "eval-rows"), ...rubric.outputs }, checks };
}
