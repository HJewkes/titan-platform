import { z } from "zod";
import type { StepRunOutcome, StepUsage } from "@titan-design/workflow";
import type { L0Result } from "../eval-l0.js";
import { loadBeatSpecs } from "../beat-load.js";
import type { BeatSpec } from "../beat-schema.js";
import { GUIDE_PLAN_STRUCTURE, guidePlan } from "../guide-plan.js";
import { leadBeatLines, leadBeats, uncuedTargets, type LeadBeat } from "../lead-beats.js";
import type { GatheredFact } from "../lint-claims.js";
import { LANES_CHAPTER, type CoverageManifest } from "../lint-coverage.js";
import { repairHint } from "../l0-repair-hints.js";
import type { Stamped, LedgerStamp } from "../ledger-stamp.js";
import { CUE_KIND_ROLES, unknownCueKinds } from "../pace-items.js";
import type { RuleRegistry } from "../rules.js";
import { budgetSection, planFaults, planHint, retimeOverBudget } from "../script-budget.js";
import { FILL_RULE, fillHint, TEMPLATE_FILL_ID } from "../script-fill.js";
import { parseScript } from "../script-load.js";
import { DraftScriptSchema, type ScriptV1 } from "../script-schema.js";
import { parseSpine, type SpineV1 } from "../spine-schema.js";
import { spellScript } from "../rewrite-pass.js";
import { UNKNOWN_WORDS_ID, UNKNOWN_WORDS_RULE, unknownWordsHint, type Tokens } from "../unknown-words.js";
import { issueText, repairReply, replyObject } from "./script-reply.js";
import { addUsage, NO_USAGE, type Check, type StageUsage } from "./records.js";

const cacheWrites = (usage: StepUsage): number => (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0);

export function stageUsage(usage: StepUsage | undefined): StageUsage {
  if (!usage) return { ...NO_USAGE, calls: 1, costUnknown: true };
  return {
    usd: usage.costUsd,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    ...(cacheWrites(usage) > 0 ? { cacheWriteTokens: cacheWrites(usage) } : {}),
    calls: 1,
    ...(usage.costUnknown ? { costUnknown: true as const } : {}),
  };
}

/** The guide names the fields in prose only, so the model also gets the exact shape the reply is parsed with. */
const scriptShape = (): string => `## The script/v1 JSON Schema\n\n\`\`\`json\n${JSON.stringify(z.toJSONSchema(DraftScriptSchema, { io: "input", unrepresentable: "any" }))}\n\`\`\``;

/** What the stage plans the script under; the script records the structure and profile whatever the reply names. */
export interface ScriptPlan {
  structure: string;
  profile?: string;
  leads: LeadBeat[];
  specs: ReadonlyMap<string, BeatSpec>;
}

export function scriptPlan(spine: SpineV1, profile?: string): ScriptPlan {
  const specs = loadBeatSpecs();
  return { structure: spine.structure ?? GUIDE_PLAN_STRUCTURE, ...(profile ? { profile } : {}), leads: leadBeats(spine, specs), specs };
}

const LEAD_BEATS = `## Lead beats

Each chapter opens on the beat spec the spine's chapter order names. Set that beat's "visual.beat" to the spec's type, and give it at least one cue per emphasis target list: its "target" is a kebab-case element id for one item of that list (such as "reasons-1"), and its "atCue" is a word the beat speaks.`;

const leadBeatSection = (leads: readonly LeadBeat[]): string[] => (leads.length > 0 ? [`${LEAD_BEATS}\n\n${leadBeatLines(leads).join("\n")}`] : []);

function laneLine(lane: CoverageManifest["lanes"][number], coverage: CoverageManifest): string {
  const prsOf = (thread: string) => coverage.prs.filter((entry) => entry.thread === thread && entry.lane === lane.id).map((entry) => entry.pr);
  const named = lane.named.map((thread) => `${thread} (${prsOf(thread).join(", ")})`).join("; ") || "none";
  return `- ${lane.label} (${lane.id}): ${lane.merged} merged, counted by ${lane.rollup}; name: ${named}`;
}

/** Per lane, the threads a script names and the rollup fact that counts the rest, so Q-E21 is met in the draft. */
export const coverageSection = (coverage: CoverageManifest): string =>
  `## Coverage (coverage.json)

Every merged PR of the day is named or counted under its lane. Name each thread below by citing its PR fact ids in the beat that names it. Count the rest of a lane in a "${LANES_CHAPTER}" chapter beat that cites the lane's rollup fact and says or shows the lane's merged total.

${coverage.lanes.map((lane) => laneLine(lane, coverage)).join("\n")}`;

/** The guide in the spine's structure and the spine, `between`, then the coverage, lead beats, budget and shape. */
function spineSections(spine: string, plan: ScriptPlan, coverage: CoverageManifest | undefined, between: readonly string[]): string[] {
  const guide = guidePlan("script", { spine: parseSpine(spine), structure: plan.structure });
  const budget = plan.profile ? [budgetSection(plan.leads, plan.profile)] : [];
  const covered = coverage ? [coverageSection(coverage)] : [];
  return [guide, `## Story spine (spine.md)\n\n${spine.trim()}`, ...between, ...covered, ...leadBeatSection(plan.leads), ...budget, scriptShape()];
}

export const factsSection = (facts: string, whose = ""): string => `## Facts pack (facts.md)${whose}\n\n${facts.trim()}`;

/**
 * Every prompt section but the task: the guide in the spine's structure, the spine, the facts, the coverage a daily
 * gather sets, the lead beats, the budget and the shape.
 */
export const promptSections = (spine: string, facts: string, plan: ScriptPlan, coverage?: CoverageManifest): string[] =>
  spineSections(spine, plan, coverage, [factsSection(facts)]);

/** The single-call sections less the facts: what every chunked call sends first, byte for byte, so the cache reads it. */
export const sharedSections = (spine: string, plan: ScriptPlan, coverage?: CoverageManifest): string[] => spineSections(spine, plan, coverage, []);

/** The reply rules every script task ends on, whole script or one chapter. */
export const REPLY_RULES = `- Every cue's atCue word must be a word the beat speaks.
- Cite only fact ids from the facts pack, and state no number the facts pack does not hold. Where the spine has a Cites table, a beat that names an item cites the fact ids that table lists for it.
- Set "facts_pack" to "facts.md".`;

export const retryPrompt = (prompt: string, error: string, reply = "Reply with the whole corrected object.\n"): string =>
  `${prompt}\n## Your previous reply was rejected\n\n${error}\n\n${reply}`;

export interface Checked {
  script?: ScriptV1;
  error?: string;
  /** Keys the schema does not allow, dropped so the rest of the reply parses. */
  stripped?: string[];
  /** Out-of-enum values on optional fields or list items, dropped the same way: one stage note each. */
  dropped?: string[];
}

const planned = (script: ScriptV1, plan: ScriptPlan): ScriptV1 => ({ ...script, structure: plan.structure, ...(plan.profile ? { profile: plan.profile } : {}) });

/**
 * The reply is checked here rather than through the CLI's `--json-schema`: that flag refuses the tuple keywords
 * ScriptSchema converts to, and zod refinements (unknown chapters, unspoken cues) never reach a JSON schema anyway.
 * A reply whose only faults are extra keys ("cues", "chips" on a beat) loses them rather than the whole script: the
 * schema retry was measured failing on the same keys again. So does one whose other faults are out-of-enum values on
 * an optional field or a list item (a chip's kind); a bad required value goes to the retry, which names the allowed ones.
 */
export function checked(outcome: StepRunOutcome, plan: ScriptPlan): Checked {
  if (!outcome.ok) return { error: outcome.error };
  let raw: unknown;
  try {
    raw = replyObject(outcome.output);
  } catch {
    return { error: "the reply holds no JSON object" };
  }
  return checkedObject(raw, plan);
}

/**
 * A reply's object as a script: parsed, its unknown keys and droppable bad values dropped, then its cue kinds, profile
 * and lead-beat cues checked. A later fault also names what was dropped, since the drop may be what caused it.
 */
export function checkedObject(raw: unknown, plan: ScriptPlan): Checked {
  const result = parsedObject(raw, plan);
  const fault = result.script ? cueKindFault(result.script) ?? profileFault(result.script) ?? cueFault(result.script, plan) : undefined;
  return fault ? { error: [fault, ...(result.dropped ?? [])].join("; ") } : result;
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

function parsedObject(raw: unknown, plan: ScriptPlan): Checked {
  const parsed = DraftScriptSchema.safeParse(raw);
  if (parsed.success) return { script: planned(parsed.data, plan) };
  const { issues } = parsed.error;
  const first = issueText(issues, raw);
  const repair = repairReply(DraftScriptSchema, raw, issues);
  if (!repair) return { error: first };
  const again = DraftScriptSchema.safeParse(raw);
  if (!again.success) return { error: `${first}; ${issueText(again.error.issues, raw)}` };
  return { script: planned(again.data, plan), stripped: repair.stripped, ...(repair.dropped.length > 0 ? { dropped: repair.dropped } : {}) };
}

const isSchemaFailure = (outcome: StepRunOutcome): boolean => outcome.ok || outcome.code === "schema_invalid";

export type Call = (prompt: string) => Promise<StepRunOutcome>;

/** How a draft's reply is read: checked into a script, and the plan faults its one plan retry names. */
export interface Reader {
  check: (outcome: StepRunOutcome) => Checked;
  faults: (script: ScriptV1) => string[];
}

export const wholeScript = (plan: ScriptPlan): Reader => ({ check: (outcome) => checked(outcome, plan), faults: planFaults });

export interface Draft extends Checked {
  usage: StageUsage;
  retried: boolean;
  /** The beats the $0 re-time raised in the kept reply, as `reflection-1 18→19 s`. */
  retimed: string[];
}

/** A parsed reply re-timed against the reader's own faults, so a draft that only needs seconds costs no retry. */
function retimedReply(reply: Checked, reader: Reader): Checked & { retimed: string[] } {
  if (!reply.script) return { ...reply, retimed: [] };
  const { draft, moves } = retimeOverBudget(reply.script, reader.faults);
  return { ...reply, script: draft, retimed: moves };
}

/** One retry naming each beat over resolve's word cap and the runtime; kept only when it parses and fails fewer. */
async function planRetry(call: Call, prompt: string, reader: Reader, draft: Draft & { script: ScriptV1 }): Promise<Draft> {
  const faults = reader.faults(draft.script);
  if (faults.length === 0) return draft;
  const outcome = await call(retryPrompt(prompt, planHint(faults)));
  const reply = retimedReply(reader.check(outcome), reader);
  const better = reply.script !== undefined && reader.faults(reply.script).length < faults.length;
  return { ...(better ? reply : draft), usage: addUsage(draft.usage, stageUsage(outcome.usage)), retried: true };
}

/** The first call, and one retry: naming the schema issues when its reply does not parse, or its plan faults when it does. */
export async function draftScript(call: Call, prompt: string, reader: Reader): Promise<Draft> {
  const first = await call(prompt);
  const result = retimedReply(reader.check(first), reader);
  const usage = stageUsage(first.usage);
  if (result.script) return planRetry(call, prompt, reader, { ...result, script: result.script, usage, retried: false });
  if (!isSchemaFailure(first)) return { ...result, usage, retried: false };
  const second = await call(retryPrompt(prompt, result.error ?? ""));
  return { ...retimedReply(reader.check(second), reader), usage: addUsage(stageUsage(first.usage), stageUsage(second.usage)), retried: true };
}

/** The re-time after the last repair round, which keeps any reply that fails fewer L0 rows whatever its word count. */
export function retimeRepaired(script: ScriptV1, earlier: readonly string[]): { script: ScriptV1; checks: Check[]; notes: string[] } {
  const { draft, moves } = retimeOverBudget(script);
  const all = [...earlier, ...moves];
  if (all.length === 0) return { script: draft, checks: [], notes: [] };
  const detail = `re-timed ${all.length} beat(s) to fit their words: ${all.join(", ")}`;
  return { script: draft, checks: [{ name: "word-budget-retime", gate: false, pass: true, detail }], notes: all.map((move) => `word-budget re-time: ${move}`) };
}

export const failingErrors = (rows: readonly L0Result[]): L0Result[] => rows.filter((row) => row.severity === "error" && !row.pass);

/** The L0 rows a repair answers, and what it needs to name what each found. */
export interface Lint {
  rows: (script: ScriptV1) => L0Result[];
  /** The gathered facts the Q-E20 rows read, so its hint names the nearest one. */
  facts?: readonly GatheredFact[];
  /** A daily gather's coverage manifest, so the Q-E21 hint names each lane and PR left out. */
  coverage?: CoverageManifest;
  spine: SpineV1;
  /** The voice's g2p, so the rounds also answer the words it has no phonemes for. */
  g2p: Tokens;
}

interface OwnRow {
  rule: string;
  hint: (row: L0Result) => string;
}

/** The rows the repair rounds answer that no L0 rule owns: each one's rule and Found line. */
const ownRows = (script: ScriptV1, lint: Pick<Lint, "g2p">): ReadonlyMap<string, OwnRow> =>
  new Map([
    [UNKNOWN_WORDS_ID, { rule: UNKNOWN_WORDS_RULE, hint: () => unknownWordsHint(lint.g2p, spellScript(script)) }],
    [TEMPLATE_FILL_ID, { rule: FILL_RULE, hint: (row: L0Result) => fillHint(script, row.detail_beats) }],
  ]);

export function failureList(rows: readonly L0Result[], rules: RuleRegistry, script: ScriptV1, lint: Pick<Lint, "facts" | "spine" | "g2p" | "coverage">): string {
  const ruleFor = (id: string) => rules.rules.find((rule) => rule.id === id || (rule.l0?.status === "implemented" && rule.l0.checks.includes(id)));
  const own = ownRows(script, lint);
  const rule = (row: L0Result) => own.get(row.check_id)?.rule ?? ruleFor(row.check_id)?.rule ?? "see the rules above";
  const where = (row: L0Result) => `beats: ${row.detail_beats.join(", ") || "the whole script"}; measured ${row.value}, needs ${row.threshold}`;
  const found = (row: L0Result) => {
    const hint = own.get(row.check_id)?.hint(row) ?? repairHint(row, script, lint.facts, lint.spine, lint.coverage);
    return hint ? `\n  Found: ${hint}` : "";
  };
  return rows.map((row) => `- ${row.check_id}: ${rule(row)} (${where(row)})${found(row)}`).join("\n");
}

export const repairPrompt = (prompt: string, draft: ScriptV1, failures: string, reply = "Reply with the whole corrected object.\n"): string =>
  `${prompt}\n## Your draft\n\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`\n\n## Checks the draft fails\n\n${failures}\n\nFix what these checks name and keep the rest. ${reply}`;

/** One repair loop: what it answers, how it asks, and how a reply becomes a measured candidate. */
export interface Rounds {
  rounds: number;
  failing: (script: ScriptV1) => L0Result[];
  prompt: (script: ScriptV1, failing: readonly L0Result[]) => string;
  read: (outcome: StepRunOutcome, current: ScriptV1, failing: readonly L0Result[]) => Checked;
  /** Settles a parsed reply before it is measured: the ledger stamp. */
  settle: (script: ScriptV1) => Stamped;
  /** When a round's rejected reply gets one retry naming why, inside the same round: the reply that retry asks for. */
  retry?: (script: ScriptV1, failing: readonly L0Result[]) => string | undefined;
}

export interface Repaired {
  script: ScriptV1;
  stamps: LedgerStamp[];
  usage: StageUsage;
  before: number;
  after: number;
  /** The kept repair's dropped keys and values; absent while the start is still the script. */
  stripped?: string[];
  dropped?: string[];
}

/** One round's reply, and when `loop.retry` allows it and the reply is rejected, one retry naming the rejection. */
async function roundReply(call: Call, loop: Rounds, script: ScriptV1, failing: readonly L0Result[]): Promise<{ reply: Checked; usage: StageUsage }> {
  const prompt = loop.prompt(script, failing);
  const outcome = await call(prompt);
  const reply = loop.read(outcome, script, failing);
  const ask = reply.script ? undefined : loop.retry?.(script, failing);
  if (ask === undefined) return { reply, usage: stageUsage(outcome.usage) };
  const again = await call(retryPrompt(prompt, reply.error ?? "", ask));
  return { reply: loop.read(again, script, failing), usage: addUsage(stageUsage(outcome.usage), stageUsage(again.usage)) };
}

/** Up to `rounds` rounds, each answering the current failing rows; a reply is kept only when it fails fewer. */
export async function repairRounds(call: Call, start: Stamped, loop: Rounds): Promise<Repaired> {
  let { script, stamps } = start;
  let failing = loop.failing(script);
  const before = failing.length;
  let usage = NO_USAGE;
  let kept: Pick<Repaired, "stripped" | "dropped"> = {};
  for (let round = 0; round < loop.rounds && failing.length > 0; round++) {
    const { reply, usage: spent } = await roundReply(call, loop, script, failing);
    usage = addUsage(usage, spent);
    const next = reply.script && loop.settle(reply.script);
    const after = next ? loop.failing(next.script) : failing;
    if (next && after.length < failing.length) [{ script, stamps }, failing, kept] = [next, after, { stripped: reply.stripped ?? [], dropped: reply.dropped ?? [] }];
  }
  return { script, stamps, usage, before, after: failing.length, ...kept };
}

/** What a drafting path hands the stage: the script, its stamps and spend, and what it reports. */
export interface Written {
  script: ScriptV1;
  stamps: LedgerStamp[];
  usage: StageUsage;
  retries: number;
  stripped: string[];
  checks: Check[];
  notes: string[];
}
