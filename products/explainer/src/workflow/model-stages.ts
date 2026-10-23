import { tmpdir } from "node:os";
import { z } from "zod";
import { agentRunner, type AgentRunnerOptions, type LegacyStepRunner, type StepRunOutcome, type StepUsage } from "@titan-design/workflow";
import { L0_CHECKS, l0HardPass, failedChecks, runL0, type L0Check, type L0Result } from "../eval-l0.js";
import { readColdRubric, rubricBeatsFromPace, rubricNote, runColdRubric } from "../eval-cold-rubric.js";
import { createJudgeHarness, type JudgeConfig, type JudgeHarness } from "../eval-harness.js";
import { canonicalSha } from "../eval-store.js";
import { loadBeatSpecs } from "../beat-load.js";
import type { BeatSpec } from "../beat-schema.js";
import { claimFacts, withClaimFacts } from "../claim-facts.js";
import { GUIDE_PLAN_STRUCTURE, guidePlan } from "../guide-plan.js";
import { leadBeatLines, leadBeats, uncuedTargets, type LeadBeat } from "../lead-beats.js";
import type { GatheredFact } from "../lint-claims.js";
import { repairHint } from "../l0-repair-hints.js";
import { stampLedgerTerms, type LedgerStamp, type Stamped } from "../ledger-stamp.js";
import { paceRows } from "../lint-pace.js";
import { CUE_KIND_ROLES, fromScriptV1, unknownCueKinds } from "../pace-items.js";
import { rewriteScript } from "../rewrite-pass.js";
import { budgetSection, planFaults, planHint } from "../script-budget.js";
import { parseScript } from "../script-load.js";
import { ScriptSchema, type ScriptV1 } from "../script-schema.js";
import { parseSpine, type SpineV1 } from "../spine-schema.js";
import { COMPANION_FILE, companionChapters, renderCompanion, reviewFacts, type ChapterLinks } from "../presets/repo-explainer/companion.js";
import type { ArtifactStore, Provenance } from "./artifacts.js";
import { loadRuleRegistry, type RuleRegistry } from "../rules.js";
import { stampCheck } from "./stamp-check.js";
import { addUsage, NO_USAGE, type Check, type StageOutcome, type StageUsage } from "./records.js";

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

export function stageUsage(usage: StepUsage | undefined): StageUsage {
  if (!usage) return { ...NO_USAGE, calls: 1, costUnknown: true };
  return {
    usd: usage.costUsd,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    calls: 1,
    ...(usage.costUnknown ? { costUnknown: true as const } : {}),
  };
}

const SCRIPT_TASK = `## Task

Write the whole script/v1 for this video as one JSON object, and reply with that object only.
- Keep every chapter id and beat id, in the order the spine's beat plan lists them, with its function and plannedS.
- Every cue's atCue word must be a word the beat speaks.
- Cite only fact ids from the facts pack, and state no number the facts pack does not hold. Where the spine has a Cites table, a beat that names an item cites the fact ids that table lists for it.
- Set "facts_pack" to "facts.md".`;

/** The guide names the fields in prose only, so the model also gets the exact shape the reply is parsed with. */
const scriptShape = (): string => `## The script/v1 JSON Schema\n\n\`\`\`json\n${JSON.stringify(z.toJSONSchema(ScriptSchema, { io: "input", unrepresentable: "any" }))}\n\`\`\``;

/** What the stage plans the script under; the script records the structure and profile whatever the reply names. */
interface ScriptPlan {
  structure: string;
  profile?: string;
  leads: LeadBeat[];
  specs: ReadonlyMap<string, BeatSpec>;
}

function scriptPlan(spine: SpineV1, profile?: string): ScriptPlan {
  const specs = loadBeatSpecs();
  return { structure: spine.structure ?? GUIDE_PLAN_STRUCTURE, ...(profile ? { profile } : {}), leads: leadBeats(spine, specs), specs };
}

const LEAD_BEATS = `## Lead beats

Each chapter opens on the beat spec the spine's chapter order names. Set that beat's "visual.beat" to the spec's type, and give it at least one cue per emphasis target list: its "target" is a kebab-case element id for one item of that list (such as "reasons-1"), and its "atCue" is a word the beat speaks.`;

const leadBeatSection = (leads: readonly LeadBeat[]): string[] => (leads.length > 0 ? [`${LEAD_BEATS}\n\n${leadBeatLines(leads).join("\n")}`] : []);

function promptFor(spine: string, facts: string, plan: ScriptPlan): string {
  const guide = guidePlan("script", { spine: parseSpine(spine), structure: plan.structure });
  const budget = plan.profile ? [budgetSection(plan.leads, plan.profile)] : [];
  const sections = [guide, `## Story spine (spine.md)\n\n${spine.trim()}`, `## Facts pack (facts.md)\n\n${facts.trim()}`, ...leadBeatSection(plan.leads), ...budget];
  return [...sections, scriptShape(), SCRIPT_TASK].join("\n\n") + "\n";
}

/** The script call's prompt: the guide in the spine's structure, the spine, the facts and each chapter's lead beat spec. */
export function scriptPrompt(spine: string, facts: string): string {
  return promptFor(spine, facts, scriptPlan(parseSpine(spine)));
}

const retryPrompt = (prompt: string, error: string): string =>
  `${prompt}\n## Your previous reply was rejected\n\n${error}\n\nReply with the whole corrected object.\n`;

/** Enough issues to fix the reply by, few enough that a reply in the wrong shape does not flood the run error. */
const MAX_ISSUES = 25;
const issueText = (issues: readonly z.core.$ZodIssue[]): string => {
  const shown = issues.slice(0, MAX_ISSUES).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return [...shown, ...(issues.length > MAX_ISSUES ? [`and ${issues.length - MAX_ISSUES} more`] : [])].join("; ");
};

/** The reply's outermost JSON object, so a reply wrapped in a code fence or a sentence still parses. */
function replyObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

const isObject = (value: unknown): value is Record<PropertyKey, unknown> => typeof value === "object" && value !== null;

/** Deletes, in place, each key zod reports as unrecognized, and returns its dotted path. */
function stripUnknownKeys(raw: unknown, issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.flatMap((issue) => {
    if (issue.code !== "unrecognized_keys") return [];
    const owner = issue.path.reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), raw);
    if (!isObject(owner)) return [];
    for (const key of issue.keys) Reflect.deleteProperty(owner, key);
    return issue.keys.map((key) => [...issue.path, key].join("."));
  });
}

interface Checked {
  script?: ScriptV1;
  error?: string;
  /** Keys the schema does not allow, dropped so the rest of the reply parses. */
  stripped?: string[];
}

const planned = (script: ScriptV1, plan: ScriptPlan): ScriptV1 => ({ ...script, structure: plan.structure, ...(plan.profile ? { profile: plan.profile } : {}) });

/**
 * The reply is checked here rather than through the CLI's `--json-schema`: that flag refuses the tuple keywords
 * ScriptSchema converts to, and zod refinements (unknown chapters, unspoken cues) never reach a JSON schema anyway.
 * A reply whose only faults are extra keys ("cues", "chips" on a beat) loses them rather than the whole script: the
 * schema retry was measured failing on the same keys again.
 */
function checked(outcome: StepRunOutcome, plan: ScriptPlan): Checked {
  const result = parsedReply(outcome, plan);
  const fault = result.script ? cueKindFault(result.script) ?? profileFault(result.script) ?? cueFault(result.script, plan) : undefined;
  return fault ? { error: fault } : result;
}

// With no run profile the reply's own stands, so an invented one is caught here rather than at resolve.
function profileFault(script: ScriptV1): string | undefined {
  try {
    parseScript(script);
    return undefined;
  } catch (error) {
    return `profile: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function cueFault(script: ScriptV1, plan: ScriptPlan): string | undefined {
  const uncued = uncuedTargets(script, plan.leads, plan.specs);
  return uncued.length > 0 ? `lead beats: ${uncued.join("; ")}` : undefined;
}

/**
 * script/v1 admits a cue target of any kind, because a beat spec assigned later reads its targets as element ids, but a
 * draft's cue targets are `kind:label`: the item track counts them by kind, so the retry names the kind and the beat.
 */
function cueKindFault(script: ScriptV1): string | undefined {
  const kinds = Object.keys(CUE_KIND_ROLES).join(", ");
  const faults = script.beats.flatMap((beat, i) =>
    unknownCueKinds(beat).map((kind) => `beats.${i}.visual.cues: cue target kind "${kind}" in ${beat.id} is not one of ${kinds}`),
  );
  return faults.length > 0 ? faults.join("; ") : undefined;
}

function parsedReply(outcome: StepRunOutcome, plan: ScriptPlan): Checked {
  if (!outcome.ok) return { error: outcome.error };
  let raw: unknown;
  try {
    raw = replyObject(outcome.output);
  } catch {
    return { error: "the reply holds no JSON object" };
  }
  const parsed = ScriptSchema.safeParse(raw);
  if (parsed.success) return { script: planned(parsed.data, plan) };
  const { issues } = parsed.error;
  if (!issues.every((issue) => issue.code === "unrecognized_keys")) return { error: issueText(issues) };
  const stripped = stripUnknownKeys(raw, issues);
  const again = ScriptSchema.safeParse(raw);
  return again.success ? { script: planned(again.data, plan), stripped } : { error: issueText([...issues, ...again.error.issues]) };
}

const isSchemaFailure = (outcome: StepRunOutcome): boolean => outcome.ok || outcome.code === "schema_invalid";

/** A stage that failed after spending: the route records the spend before the run fails, so the report still shows it. */
export class StageFailure extends Error {
  constructor(message: string, readonly usage: StageUsage, readonly retries = 0, readonly checks: readonly Check[] = []) {
    super(message);
    this.name = "StageFailure";
  }
}

export interface ScriptStageDeps {
  model: string;
  /** The run's video type, stamped on the script; a run with no profile keeps the reply's, checked against the registry. */
  profile?: string;
  runnerFor?: RunnerFor;
  /** The L0 checks the repair call answers; all of them by default. */
  l0Checks?: readonly L0Check[];
  signal?: AbortSignal;
}

type Call = (prompt: string) => Promise<StepRunOutcome>;

interface Draft extends Checked {
  usage: StageUsage;
  retried: boolean;
}

/** One retry naming each beat over resolve's word cap and the runtime; kept only when it parses and fails fewer. */
async function planRetry(call: Call, prompt: string, plan: ScriptPlan, draft: Draft & { script: ScriptV1 }): Promise<Draft> {
  const faults = planFaults(draft.script);
  if (faults.length === 0) return draft;
  const outcome = await call(retryPrompt(prompt, planHint(faults)));
  const reply = checked(outcome, plan);
  const better = reply.script !== undefined && planFaults(reply.script).length < faults.length;
  return { ...(better ? reply : draft), usage: addUsage(draft.usage, stageUsage(outcome.usage)), retried: true };
}

/** The first call, and one retry: naming the schema issues when its reply does not parse, or its plan faults when it does. */
async function draftScript(call: Call, prompt: string, plan: ScriptPlan): Promise<Draft> {
  const first = await call(prompt);
  const result = checked(first, plan);
  const usage = stageUsage(first.usage);
  if (result.script) return planRetry(call, prompt, plan, { ...result, script: result.script, usage, retried: false });
  if (!isSchemaFailure(first)) return { ...result, usage, retried: false };
  const second = await call(retryPrompt(prompt, result.error ?? ""));
  return { ...checked(second, plan), usage: addUsage(stageUsage(first.usage), stageUsage(second.usage)), retried: true };
}

const failingErrors = (rows: readonly L0Result[]): L0Result[] => rows.filter((row) => row.severity === "error" && !row.pass);

function failureList(rows: readonly L0Result[], rules: RuleRegistry, script: ScriptV1, facts?: readonly GatheredFact[], spine?: SpineV1): string {
  const ruleFor = (id: string) => rules.rules.find((rule) => rule.id === id || (rule.l0?.status === "implemented" && rule.l0.checks.includes(id)));
  const where = (row: L0Result) => `beats: ${row.detail_beats.join(", ") || "the whole script"}; measured ${row.value}, needs ${row.threshold}`;
  const found = (row: L0Result) => {
    const hint = repairHint(row, script, facts, spine);
    return hint ? `\n  Found: ${hint}` : "";
  };
  return rows.map((row) => `- ${row.check_id}: ${ruleFor(row.check_id)?.rule ?? "see the rules above"} (${where(row)})${found(row)}`).join("\n");
}

const repairPrompt = (prompt: string, draft: ScriptV1, failures: string): string =>
  `${prompt}\n## Your draft\n\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`\n\n## Checks the draft fails\n\n${failures}\n\nFix what these checks name and keep the rest. Reply with the whole corrected object.\n`;

interface Repair {
  script: ScriptV1;
  stamps: LedgerStamp[];
  usage: StageUsage;
  check: Check;
  /** The kept repair's dropped keys; absent while the draft is still the script. */
  stripped?: string[];
}

/** A repair answers a few rows at a time well; measured on one video, one round left half of the error rows red. */
export const MAX_REPAIR_ROUNDS = 2;

/**
 * Up to `MAX_REPAIR_ROUNDS` calls, each answering the current script's failing error-severity L0 rows. A reply is
 * kept only when it parses and fails fewer rows, so a round never makes the script worse.
 */
interface Lint {
  rows: (script: ScriptV1) => L0Result[];
  /** The gathered facts the Q-E20 rows read, so its hint names the nearest one. */
  facts?: readonly GatheredFact[];
  spine: SpineV1;
}

async function repairScript(call: Call, prompt: string, plan: ScriptPlan, draft: Stamped, { rows: lint, facts, spine }: Lint): Promise<Repair | undefined> {
  const first = failingErrors(lint(draft.script)).length;
  if (first === 0) return undefined;
  const rules = loadRuleRegistry();
  let { script, stamps } = draft;
  let failing = failingErrors(lint(script));
  let usage = NO_USAGE;
  let stripped: string[] | undefined;
  for (let round = 0; round < MAX_REPAIR_ROUNDS && failing.length > 0; round++) {
    const outcome = await call(repairPrompt(prompt, script, failureList(failing, rules, script, facts, spine)));
    usage = addUsage(usage, stageUsage(outcome.usage));
    const reply = checked(outcome, plan);
    const next = reply.script && stampLedgerTerms(reply.script, spine);
    const after = next ? failingErrors(lint(next.script)) : failing;
    if (next && after.length < failing.length) [{ script, stamps }, failing, stripped] = [next, after, reply.stripped ?? []];
  }
  const detail = `${first} failing error checks before repair, ${failing.length} after`;
  return { script, stamps, usage, ...(stripped ? { stripped } : {}), check: { name: "l0-repair", gate: false, pass: failing.length === 0, detail } };
}

const SHOWN_KEYS = 10;

/** Reported only: the kept script parsed once these keys were dropped, so a reader sees what the model added. */
function unknownKeysCheck(stripped: readonly string[]): Check[] {
  if (stripped.length === 0) return [];
  const shown = stripped.slice(0, SHOWN_KEYS).join(", ") + (stripped.length > SHOWN_KEYS ? ` and ${stripped.length - SHOWN_KEYS} more` : "");
  return [{ name: "script-unknown-keys", gate: false, pass: false, detail: `dropped ${stripped.length} key(s) the schema does not allow: ${shown}` }];
}

/** One model call from spine and facts to a script/v1 draft, one retry that names schema issues, then the L0 repair rounds. */
export async function runScriptStage(input: ModelStageInput, deps: ScriptStageDeps): Promise<StageOutcome> {
  const spineText = input.store.readText(need(input, "spine"));
  const spine = parseSpine(spineText);
  const plan = scriptPlan(spine, deps.profile);
  const factsText = input.store.readText(need(input, "facts"));
  const prompt = promptFor(spineText, factsText, plan);
  const maxBudgetUsd = Math.max(0.01, Math.min(SCRIPT_CALL_USD, input.remainingUsd));
  const runner = (deps.runnerFor ?? agentRunner)({ cwd: tmpdir(), maxTurns: 1, maxBudgetUsd, defaults: { harness: "claude-print", model: deps.model } });
  const signal = deps.signal ?? new AbortController().signal;
  const call: Call = (text) => runner.run({ runId: input.from.runId, workflowName: "explainer-video", stepId: "script", iteration: 0, prompt: text, signal });
  const draft = await draftScript(call, prompt, plan);
  const retries = draft.retried ? 1 : 0;
  if (!draft.script) throw new StageFailure(`script: ${draft.error}`, draft.usage, retries);
  const facts = claimFacts(factsText);
  const l0Checks = withClaimFacts(deps.l0Checks ?? L0_CHECKS, facts);
  const lint: Lint = { rows: (script) => runL0(script, undefined, l0Checks, undefined, spine), spine, ...(facts ? { facts } : {}) };
  const stamped = stampLedgerTerms(draft.script, spine);
  const repair = await repairScript(call, prompt, plan, stamped, lint);
  const usage = repair ? addUsage(draft.usage, repair.usage) : draft.usage;
  const stripped = repair?.stripped ?? draft.stripped ?? [];
  const checks: Check[] = [{ name: "script-schema", gate: true, pass: true }, ...unknownKeysCheck(stripped), ...stampCheck(repair?.stamps ?? stamped.stamps), ...(repair ? [repair.check] : [])];
  const script = repair?.script ?? stamped.script;
  const companion = companionOutputs(input, script, spine);
  return { outputs: { draft: putJson(input, script, "script"), ...companion.outputs }, usage, retries, checks, notes: companion.notes };
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
  const l0 = runL0(script, undefined, withClaimFacts(l0Checks, facts), undefined, spine);
  const pace = paceRows(fromScriptV1(script), script.video.invariants ?? []);
  const checks = [verdict("l0", l0), verdict("pace", pace)];
  const red = checks.filter((check) => !check.pass);
  if (red.length > 0) throw new StageFailure(`eval: ${red.map((check) => `${check.name} ${check.detail}`).join("; ")}`, NO_USAGE, 0, checks);
  const rubric = await reportColdRubric(input, script, deps);
  return { ...rubric, outputs: { l0: putJson(input, { l0, pace }, "eval-rows"), ...rubric.outputs }, checks };
}
