import { z } from "zod";
import { L0_CHECKS, runL0, type L0Check, type L0Result } from "./eval-l0.js";
import { judgeLabel, type JudgeConfig, type JudgeHarness } from "./eval-harness.js";
import { MAX_SENTENCE_WORDS, MAX_VETTED_SENTENCE_WORDS, voiceCheck, voiceCheckWith, type SpeechVerdict } from "./lint-voice.js";
import { guardBeat, rewrittenBeat, type BeatGuardOptions, type BeatRejection } from "./rewrite-guard.js";
import { MAX_REWRITE_ROUNDS, REWRITE_TARGET_ROWS, planRegisterEdits, type RegisterEditPlan } from "./rewrite-plan.js";
import { renderRewritePrompt } from "./rewrite-prompt.js";
import { ScriptSchema, type ScriptBeat, type ScriptChapter, type ScriptV1 } from "./script-schema.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";

export interface RewriteDeps {
  harness: JudgeHarness;
  /** The config the harness was built from; the report names it. */
  judge: JudgeConfig;
  rounds?: number;
  /** Lets a sentence of 26 to 32 words through the guard and Q-V9; without it the plan stays under the plain cap. */
  speechClean?: SpeechVerdict;
  /** Passed to speech-vet's guard for each beat. */
  guard?: BeatGuardOptions["guard"];
  /** Overrides the shipped `doctrine/guides` directory. */
  guidesDir?: string;
}

const RewriteReplySchema = z.object({
  beats: z.array(z.object({ id: z.string(), spoken: z.string(), labels_added: z.array(z.string()) })),
});
type ReplyBeat = z.infer<typeof RewriteReplySchema>["beats"][number];

export interface RewriteCall {
  round: number;
  chapter: string;
  ok: boolean;
  /** Why the call failed; its chapter was left unchanged. */
  reason?: string;
  usd: number;
  tokensIn: number;
  tokensOut: number;
}

export interface RejectedBeat {
  beat: string;
  /** The guard's reasons, or `missing` when the reply skipped a beat it was asked to rewrite. */
  rejections: (BeatRejection | { rule: "missing"; detail: string })[];
}

export interface RevertedBeat {
  beat: string;
  /** The error rows the rewrite made this beat fail. */
  rows: string[];
}

export interface RoundReport {
  round: number;
  /** False when the round made the target rows worse; the script before it was kept. */
  kept: boolean;
  why?: string;
  failing: { before: number; after: number };
  distance: { before: number; after: number };
  rewritten: string[];
  rejected: RejectedBeat[];
  reverted: RevertedBeat[];
}

export type TargetRow = Pick<L0Result, "check_id" | "value" | "threshold" | "pass">;

export interface RewriteReport {
  judge: string;
  before: TargetRow[];
  after: TargetRow[];
  rounds: RoundReport[];
  calls: RewriteCall[];
  usd: number;
  tokensIn: number;
  tokensOut: number;
}

export interface RewriteResult {
  script: ScriptV1;
  report: RewriteReport;
}

const TARGETS: ReadonlySet<string> = new Set(REWRITE_TARGET_ROWS);
const targetRows = (rows: readonly L0Result[]): TargetRow[] =>
  rows.filter((row) => TARGETS.has(row.check_id)).map(({ check_id, value, threshold, pass }) => ({ check_id, value, threshold, pass }));

const failingTargets = (rows: readonly L0Result[]): number => targetRows(rows).filter((row) => !row.pass).length;
const failingErrors = (rows: readonly L0Result[]): number => rows.filter((row) => row.severity === "error" && !row.pass).length;

/** How far a failing row sits outside its band, relative to the edge it missed; a count row's edge is zero. */
const rowDistance = ({ pass, value, threshold }: TargetRow): number =>
  pass ? 0 : threshold === 0 ? Math.abs(value) : Math.abs(value - threshold) / threshold;

/** The target rows' summed distance to band: zero only when all of them pass. */
export const bandDistance = (rows: readonly L0Result[]): number => targetRows(rows).reduce((sum, row) => sum + rowDistance(row), 0);

/** Why a round's result must be discarded, or undefined to keep it. */
export function roundRefusal(before: readonly L0Result[], after: readonly L0Result[]): string | undefined {
  if (failingTargets(after) > failingTargets(before)) return "more target rows fail";
  if (bandDistance(after) >= bandDistance(before)) return "the distance to band did not fall";
  if (failingErrors(after) > failingErrors(before)) return "more error rows fail";
  return undefined;
}

/** L0 as the pass sees it: with a verdict, a vetted long sentence is no Q-V9 error. */
const passChecks = (speechClean: SpeechVerdict | undefined): readonly L0Check[] =>
  speechClean ? L0_CHECKS.map((check) => (check === voiceCheck ? voiceCheckWith([], { speechClean }) : check)) : L0_CHECKS;

interface ChapterReply {
  call: RewriteCall;
  beats?: ReplyBeat[];
}

async function callChapter(chapter: ScriptChapter, script: ScriptV1, plan: RegisterEditPlan, deps: RewriteDeps): Promise<ChapterReply> {
  const beats = script.beats.filter((beat) => beat.chapter === chapter.id);
  const prompt = renderRewritePrompt(chapter, beats, plan, deps.guidesDir ? { guidesDir: deps.guidesDir } : {});
  const at = { round: plan.round, chapter: chapter.id };
  try {
    const reply = await deps.harness({ prompt, schema: RewriteReplySchema });
    const spend = { usd: reply.usd, tokensIn: reply.tokensIn, tokensOut: reply.tokensOut };
    return reply.ok ? { call: { ...at, ok: true, ...spend }, beats: reply.output.beats } : { call: { ...at, ok: false, reason: reply.reason, ...spend } };
  } catch (error) {
    return { call: { ...at, ok: false, reason: error instanceof Error ? error.message : String(error), usd: 0, tokensIn: 0, tokensOut: 0 } };
  }
}

interface Merged {
  beats: ScriptBeat[];
  rewritten: string[];
  rejected: RejectedBeat[];
}

/** Each directed beat a reply answered and the guard accepts replaces its original; every other beat stays. */
function mergeReplies(script: ScriptV1, plan: RegisterEditPlan, replies: readonly ChapterReply[], deps: RewriteDeps): Merged {
  const answered = new Map(replies.flatMap((reply) => reply.beats ?? []).map((beat) => [beat.id, beat]));
  const called = new Set(replies.filter((reply) => reply.beats).map((reply) => reply.call.chapter));
  const directed = new Set(plan.directives.map((directive) => directive.beat));
  const merged: Merged = { beats: [], rewritten: [], rejected: [] };
  for (const beat of script.beats) {
    const reply = directed.has(beat.id) && called.has(beat.chapter) ? answered.get(beat.id) : undefined;
    if (directed.has(beat.id) && called.has(beat.chapter) && !reply) {
      merged.rejected.push({ beat: beat.id, rejections: [{ rule: "missing", detail: "the reply has no entry for this beat" }] });
    }
    merged.beats.push(reply ? applyReply(beat, reply, merged, deps) : beat);
  }
  return merged;
}

function applyReply(beat: ScriptBeat, reply: ReplyBeat, merged: Merged, deps: RewriteDeps): ScriptBeat {
  const labelsAdded = reply.labels_added.map((label) => label.trim()).filter(Boolean);
  // Spelled before the guard so its cap, the speech-vet and L0 all judge the words the voice will read.
  const spoken = spellSpokenNumbers({ spoken: reply.spoken, visual: beat.visual }).spoken;
  if (spoken === beat.spoken && labelsAdded.length === 0) return beat;
  const options: BeatGuardOptions = { ...(deps.guard ? { guard: deps.guard } : {}), ...(deps.speechClean ? { speechClean: deps.speechClean } : {}) };
  const rejections = guardBeat(beat, { spoken, labelsAdded }, options);
  if (rejections.length > 0) {
    merged.rejected.push({ beat: beat.id, rejections });
    return beat;
  }
  merged.rewritten.push(beat.id);
  return rewrittenBeat(beat, { spoken, labelsAdded });
}

/** The rewritten beats a failing error row names that it did not name before the round. */
function gainedErrors(before: readonly L0Result[], after: readonly L0Result[], rewritten: readonly string[]): RevertedBeat[] {
  const failedBefore = new Map(before.filter((row) => !row.pass).map((row) => [row.check_id, new Set(row.detail_beats)]));
  const gained = after
    .filter((row) => row.severity === "error" && !row.pass)
    .flatMap((row) => row.detail_beats.filter((beat) => !failedBefore.get(row.check_id)?.has(beat)).map((beat) => [beat, row.check_id] as const));
  return rewritten.flatMap((beat) => {
    const rows = [...new Set(gained.filter(([id]) => id === beat).map(([, row]) => row))];
    return rows.length > 0 ? [{ beat, rows }] : [];
  });
}

interface RoundOutcome {
  script: ScriptV1;
  rows: L0Result[];
  calls: RewriteCall[];
  report?: RoundReport;
}

async function runRound(script: ScriptV1, rows: L0Result[], round: number, deps: RewriteDeps, checks: readonly L0Check[]): Promise<RoundOutcome> {
  const cap = deps.speechClean ? MAX_VETTED_SENTENCE_WORDS : MAX_SENTENCE_WORDS;
  const plan = planRegisterEdits(script, rows, { round, cap });
  const chapters = script.chapters.filter((chapter) => plan.directives.some((directive) => directive.chapter === chapter.id));
  if (chapters.length === 0) return { script, rows, calls: [] };
  const replies = await Promise.all(chapters.map((chapter) => callChapter(chapter, script, plan, deps)));
  const merged = mergeReplies(script, plan, replies, deps);
  const mergedRows = runL0({ ...script, beats: merged.beats }, undefined, checks);
  const reverted = gainedErrors(rows, mergedRows, merged.rewritten);
  const back = new Set(reverted.map((r) => r.beat));
  const next = { ...script, beats: merged.beats.map((beat, i) => (back.has(beat.id) ? script.beats[i]! : beat)) };
  const nextRows = back.size > 0 ? runL0(next, undefined, checks) : mergedRows;
  const why = roundRefusal(rows, nextRows);
  const report: RoundReport = {
    round,
    kept: why === undefined,
    ...(why ? { why } : {}),
    failing: { before: failingTargets(rows), after: failingTargets(nextRows) },
    distance: { before: bandDistance(rows), after: bandDistance(nextRows) },
    rewritten: merged.rewritten.filter((beat) => !back.has(beat)),
    rejected: merged.rejected,
    reverted,
  };
  const calls = replies.map((reply) => reply.call);
  return why ? { script, rows, calls, report } : { script: next, rows: nextRows, calls, report };
}

const sum = (calls: readonly RewriteCall[], key: "usd" | "tokensIn" | "tokensOut"): number => calls.reduce((total, call) => total + call[key], 0);

const spellScript = (script: ScriptV1): ScriptV1 => ScriptSchema.parse({ ...script, beats: script.beats.map(spellSpokenNumbers) });

function checkRounds(rounds: number): number {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_REWRITE_ROUNDS) {
    throw new RangeError(`rewrite rounds ${rounds} is outside 1..${MAX_REWRITE_ROUNDS}`);
  }
  return rounds;
}

/**
 * Rewrites spoken lines toward the Q-V11 target rows, one schema-bound model call per chapter a round. A round is kept
 * only when it fails no more target rows and comes closer to band; a beat that gains an error row is reverted, and a
 * failed call leaves its chapter as it was. Numbers are spelled for the voice before the first round and in each candidate before it is vetted.
 */
export async function rewriteScript(script: ScriptV1, deps: RewriteDeps): Promise<RewriteResult> {
  const rounds = checkRounds(deps.rounds ?? MAX_REWRITE_ROUNDS);
  const checks = passChecks(deps.speechClean);
  const spelledInput = spellScript(script);
  const before = runL0(spelledInput, undefined, checks);
  let current = { script: spelledInput, rows: before };
  const reports: RoundReport[] = [];
  const calls: RewriteCall[] = [];
  for (let round = 1; round <= rounds && failingTargets(current.rows) > 0; round++) {
    const outcome = await runRound(current.script, current.rows, round, deps, checks);
    calls.push(...outcome.calls);
    if (outcome.report) reports.push(outcome.report);
    current = outcome;
  }
  // A safety net: every beat was spelled on the way in, so this changes nothing.
  const spelled = spellScript(current.script);
  const after = runL0(spelled, undefined, checks);
  return {
    script: spelled,
    report: {
      judge: judgeLabel(deps.judge),
      before: targetRows(before),
      after: targetRows(after),
      rounds: reports,
      calls,
      usd: sum(calls, "usd"),
      tokensIn: sum(calls, "tokensIn"),
      tokensOut: sum(calls, "tokensOut"),
    },
  };
}
