import { z } from "zod";
import { L0_CHECKS, runL0, type L0Check, type L0Result } from "./eval-l0.js";
import { judgeLabel, type JudgeConfig, type JudgeHarness } from "./eval-harness.js";
import { wordsOf } from "./lint-text.js";
import { MAX_SENTENCE_WORDS, MAX_VETTED_SENTENCE_WORDS, voiceCheck, voiceCheckWith, type SpeechVerdict } from "./lint-voice.js";
import { spokenText } from "./lint-register.js";
import { guardBeat, rewrittenBeat, splitOverlong, type BeatGuardOptions, type BeatRejection } from "./rewrite-guard.js";
import { MAX_REWRITE_ROUNDS, REWRITE_TARGET_ROWS, planRegisterEdits, type RefusalRule, type RegisterEditPlan } from "./rewrite-plan.js";
import { renderRewritePrompt } from "./rewrite-prompt.js";
import { overBudget } from "./resolve-budget.js";
import { draftBudgets } from "./script-budget.js";
import { draftFillRefusals, TEMPLATE_FILL_ID } from "./script-fill.js";
import { ScriptSchema, type ScriptBeat, type ScriptChapter, type ScriptV1 } from "./script-schema.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";
import { declareReadings } from "./heteronym-readings.js";
import { humanSignalRowsAt } from "./writing-statuses.js";

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
  /** What the model proposed, spelled for the voice; absent when the reply had no entry for the beat. */
  candidate?: { spoken: string; labels_added: string[] };
}

export interface RevertedBeat {
  beat: string;
  /** The error rows the rewrite made this beat fail, and `word-budget` when it took the beat or its block over a cap. */
  rows: string[];
}

/** Whether one chapter's accepted beats were kept on top of the chapters kept before it, and if not, why. */
export interface ChapterVerdict {
  chapter: string;
  kept: boolean;
  why?: ChapterRefusal["why"];
  /** The rows that turned red, when a row did. */
  rows?: string[];
  /** On a reverted chapter, what the guard accepted for each of its beats, so a replay can see what the revert threw away. */
  candidates?: AcceptedCandidate[];
}

export interface AcceptedCandidate {
  beat: string;
  spoken: string;
  labels_added: string[];
}

export interface RoundReport {
  round: number;
  /** False when every chapter was reverted; the script before the round was kept. */
  kept: boolean;
  why?: string;
  failing: { before: number; after: number };
  distance: { before: number; after: number };
  rewritten: string[];
  rejected: RejectedBeat[];
  reverted: RevertedBeat[];
  /** Each chapter with an accepted beat, in the order it was tried. */
  chapters: ChapterVerdict[];
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

/**
 * The register rows outside the targets that a chapter must not turn red (TP-3817 D5): each row whose status in
 * `doctrine/writing-check.json` is gate or warning at a script of this many spoken words (TP-4662). A report-only or
 * dropped row says nothing about human-ness at that length, so the pass neither chases nor protects it.
 */
export const protectedRows = (words: number): Set<string> =>
  new Set([...humanSignalRowsAt(words)].map((row) => `register:${row}`).filter((id) => !TARGETS.has(id)));

export interface ChapterRefusal {
  why: "more target rows fail" | "the distance to band did not fall" | "more error rows fail" | "a protected row turned red";
  rows?: string[];
}

const turnedRed = (before: readonly L0Result[], after: readonly L0Result[], ids: (row: L0Result) => boolean): string[] => {
  const passedBefore = new Set(before.filter((row) => row.pass && ids(row)).map((row) => row.check_id));
  return after.filter((row) => !row.pass && passedBefore.has(row.check_id)).map((row) => row.check_id);
};

/** Why a chapter's rewrite must be reverted, judged against the script it lands on; undefined to keep it. */
export function chapterRefusal(before: readonly L0Result[], after: readonly L0Result[], protectedIds: ReadonlySet<string>): ChapterRefusal | undefined {
  if (failingTargets(after) > failingTargets(before)) return { why: "more target rows fail", rows: turnedRed(before, after, (row) => TARGETS.has(row.check_id)) };
  if (bandDistance(after) >= bandDistance(before)) return { why: "the distance to band did not fall" };
  if (failingErrors(after) > failingErrors(before)) return { why: "more error rows fail", rows: turnedRed(before, after, (row) => row.severity === "error") };
  const flipped = turnedRed(before, after, (row) => protectedIds.has(row.check_id));
  return flipped.length > 0 ? { why: "a protected row turned red", rows: flipped } : undefined;
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
  accepted: AcceptedCandidate[];
  rejected: RejectedBeat[];
}

/** Each directed beat a reply answered and the guard accepts replaces its original; every other beat stays. */
function mergeReplies(script: ScriptV1, plan: RegisterEditPlan, replies: readonly ChapterReply[], deps: RewriteDeps): Merged {
  const answered = new Map(replies.flatMap((reply) => reply.beats ?? []).map((beat) => [beat.id, beat]));
  const called = new Set(replies.filter((reply) => reply.beats).map((reply) => reply.call.chapter));
  const directed = new Set(plan.directives.map((directive) => directive.beat));
  const merged: Merged = { beats: [], rewritten: [], accepted: [], rejected: [] };
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
  // Spelled and declared before the guard so its cap, the speech-vet and L0 all judge the words the voice will read,
  // and a reply that drops a `[w](=reading)` its context decides is not reverted for Q-V10.
  const spoken = splitOverlong(beat.spoken, declareReadings(spellSpokenNumbers({ spoken: reply.spoken, visual: beat.visual }).spoken), deps.speechClean);
  if (spoken === beat.spoken && labelsAdded.length === 0) return beat;
  const options: BeatGuardOptions = { ...(deps.guard ? { guard: deps.guard } : {}), ...(deps.speechClean ? { speechClean: deps.speechClean } : {}) };
  const rejections = guardBeat(beat, { spoken, labelsAdded }, options);
  if (rejections.length > 0) {
    merged.rejected.push({ beat: beat.id, rejections, candidate: { spoken, labels_added: labelsAdded } });
    return beat;
  }
  merged.rewritten.push(beat.id);
  merged.accepted.push({ beat: beat.id, spoken, labels_added: labelsAdded });
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

const overKeys = (beats: readonly ScriptBeat[], profile: string): Set<string> =>
  new Set(overBudget(draftBudgets({ beats: [...beats], profile })).map((row) => `${row.scope}:${row.id}`));

/**
 * The rewritten beats that took their beat, or by growing their block, a block over its word cap. The script stage
 * holds the draft to resolve's caps, so a rewrite that breaks one is reverted rather than failing resolve (TP-4288).
 */
function gainedBudget(script: ScriptV1, after: readonly ScriptBeat[], rewritten: readonly string[]): RevertedBeat[] {
  const was = overKeys(script.beats, script.profile);
  const gained = new Set([...overKeys(after, script.profile)].filter((key) => !was.has(key)));
  const wordsAt = (beats: readonly ScriptBeat[], i: number): number => wordsOf(beats[i]!.spoken).length;
  return rewritten.flatMap((id) => {
    const i = script.beats.findIndex((beat) => beat.id === id);
    const blockGrew = gained.has(`block:${script.beats[i]!.chapter}`) && wordsAt(after, i) > wordsAt(script.beats, i);
    return gained.has(`beat:${id}`) || blockGrew ? [{ beat: id, rows: ["word-budget"] }] : [];
  });
}

const refusedBeats = (script: ScriptV1): Set<string> => new Set(draftFillRefusals(script).map((fault) => fault.beat));

/** The rewritten beats whose appended labels make resolve's template fill refuse them, as the script stage would. */
function gainedFill(script: ScriptV1, after: readonly ScriptBeat[], rewritten: readonly string[]): RevertedBeat[] {
  const was = refusedBeats(script);
  const now = refusedBeats({ ...script, beats: [...after] });
  return rewritten.flatMap((beat) => (now.has(beat) && !was.has(beat) ? [{ beat, rows: [TEMPLATE_FILL_ID] }] : []));
}

/** One entry per beat, its rows from every source in order. */
function joinReverts(...sources: readonly RevertedBeat[][]): RevertedBeat[] {
  const rows = new Map<string, string[]>();
  for (const { beat, rows: from } of sources.flat()) rows.set(beat, [...(rows.get(beat) ?? []), ...from]);
  return [...rows].map(([beat, beatRows]) => ({ beat, rows: beatRows }));
}

/** The rewritten beats a round puts back: each that gained an error row, took a word budget over its cap or broke the fill. */
function revertedBeats(script: ScriptV1, rows: readonly L0Result[], merged: Merged, checks: readonly L0Check[]): RevertedBeat[] {
  const errors = gainedErrors(rows, runL0({ ...script, beats: merged.beats }, undefined, checks), merged.rewritten);
  return joinReverts(errors, gainedBudget(script, merged.beats, merged.rewritten), gainedFill(script, merged.beats, merged.rewritten));
}

interface RoundOutcome {
  script: ScriptV1;
  rows: L0Result[];
  calls: RewriteCall[];
  report?: RoundReport;
}

interface Greedy {
  script: ScriptV1;
  rows: L0Result[];
  chapters: ChapterVerdict[];
}

const withChapter = (onto: ScriptV1, from: readonly ScriptBeat[], chapter: string): ScriptV1 =>
  ({ ...onto, beats: onto.beats.map((beat, i) => (beat.chapter === chapter ? from[i]! : beat)) });

/**
 * Tries each changed chapter on top of the chapters already kept, the one that alone comes closest to band first, so
 * one chapter that flips a row costs only its own gain (TP-3817 D2).
 */
function keepChapters(script: ScriptV1, rows: L0Result[], candidate: readonly ScriptBeat[], checks: readonly L0Check[]): Greedy {
  const changed = script.chapters.map((chapter) => chapter.id).filter((id) => script.beats.some((beat, i) => beat.chapter === id && candidate[i] !== beat));
  const solo = new Map(changed.map((id) => [id, bandDistance(runL0(withChapter(script, candidate, id), undefined, checks))]));
  const order = [...changed].sort((a, b) => solo.get(a)! - solo.get(b)!);
  const guarded = protectedRows(spokenText(script.beats.map((beat) => beat.spoken)).words.length);
  let kept: Greedy = { script, rows, chapters: [] };
  for (const chapter of order) {
    const next = withChapter(kept.script, candidate, chapter);
    const nextRows = runL0(next, undefined, checks);
    const refusal = chapterRefusal(kept.rows, nextRows, guarded);
    const verdict: ChapterVerdict = refusal ? { chapter, kept: false, ...refusal } : { chapter, kept: true };
    kept = refusal ? { ...kept, chapters: [...kept.chapters, verdict] } : { script: next, rows: nextRows, chapters: [...kept.chapters, verdict] };
  }
  return kept;
}

type Refusals = ReadonlyMap<string, readonly RefusalRule[]>;

/** The beats a round refused, so the next round can tell the model why (TP-3817 S20). */
const refusalsOf = (report: RoundReport | undefined): Refusals =>
  new Map((report?.rejected ?? []).map(({ beat, rejections }) => [beat, rejections.map((rejection) => rejection.rule)]));

interface RoundInput {
  script: ScriptV1;
  rows: L0Result[];
  refused: Refusals;
}

async function runRound({ script, rows, refused }: RoundInput, round: number, deps: RewriteDeps, checks: readonly L0Check[]): Promise<RoundOutcome> {
  const cap = deps.speechClean ? MAX_VETTED_SENTENCE_WORDS : MAX_SENTENCE_WORDS;
  const plan = planRegisterEdits(script, rows, { round, cap, refused });
  const chapters = script.chapters.filter((chapter) => plan.directives.some((directive) => directive.chapter === chapter.id));
  if (chapters.length === 0) return { script, rows, calls: [] };
  const replies = await Promise.all(chapters.map((chapter) => callChapter(chapter, script, plan, deps)));
  const merged = mergeReplies(script, plan, replies, deps);
  const reverted = revertedBeats(script, rows, merged, checks);
  const back = new Set(reverted.map((r) => r.beat));
  const candidate = merged.beats.map((beat, i) => (back.has(beat.id) ? script.beats[i]! : beat));
  const greedy = keepChapters(script, rows, candidate, checks);
  const keptChapters = new Set(greedy.chapters.filter((verdict) => verdict.kept).map((verdict) => verdict.chapter));
  const chapterOf = new Map(script.beats.map((beat) => [beat.id, beat.chapter]));
  const withCandidates = (verdict: ChapterVerdict): ChapterVerdict => verdict.kept ? verdict : {
    ...verdict,
    candidates: merged.accepted.filter((accepted) => !back.has(accepted.beat) && chapterOf.get(accepted.beat) === verdict.chapter),
  };
  const report: RoundReport = {
    round,
    kept: keptChapters.size > 0,
    ...(keptChapters.size === 0 ? { why: "every chapter was reverted" } : {}),
    failing: { before: failingTargets(rows), after: failingTargets(greedy.rows) },
    distance: { before: bandDistance(rows), after: bandDistance(greedy.rows) },
    rewritten: merged.rewritten.filter((id) => !back.has(id) && keptChapters.has(script.beats.find((beat) => beat.id === id)!.chapter)),
    rejected: merged.rejected,
    reverted,
    chapters: greedy.chapters.map(withCandidates),
  };
  return { script: greedy.script, rows: greedy.rows, calls: replies.map((reply) => reply.call), report };
}

const sum = (calls: readonly RewriteCall[], key: "usd" | "tokensIn" | "tokensOut"): number => calls.reduce((total, call) => total + call[key], 0);

/** The script with its digits spelled as the voice reads them; the like-for-like baseline for a rewrite gate. */
export const spellScript = (script: ScriptV1): ScriptV1 => ScriptSchema.parse({ ...script, beats: script.beats.map(spellSpokenNumbers) });

/** Every beat was spelled on the way in, so this changes nothing unless a path let digits through. */
const safetyNetSpelling = spellScript;

function checkRounds(rounds: number): number {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_REWRITE_ROUNDS) {
    throw new RangeError(`rewrite rounds ${rounds} is outside 1..${MAX_REWRITE_ROUNDS}`);
  }
  return rounds;
}

/**
 * Rewrites spoken lines toward the Q-V11 target rows, one schema-bound model call per chapter a round. A chapter is kept
 * only when, on top of the chapters kept before it, it fails no more target rows, comes closer to band, fails no more
 * error rows and turns no protected row red; a beat that gains an error row or goes over its word cap is reverted, and a failed call leaves its
 * chapter as it was. Numbers are spelled for the voice before the first round and in each candidate before it is vetted,
 * and a candidate's new sentence over the cap is split at a clause joint before it is vetted.
 */
export async function rewriteScript(script: ScriptV1, deps: RewriteDeps): Promise<RewriteResult> {
  const rounds = checkRounds(deps.rounds ?? MAX_REWRITE_ROUNDS);
  const checks = passChecks(deps.speechClean);
  const spelledInput = spellScript(script);
  const before = runL0(spelledInput, undefined, checks);
  let current: RoundInput = { script: spelledInput, rows: before, refused: new Map() };
  const reports: RoundReport[] = [];
  const calls: RewriteCall[] = [];
  for (let round = 1; round <= rounds && failingTargets(current.rows) > 0; round++) {
    const outcome = await runRound(current, round, deps, checks);
    calls.push(...outcome.calls);
    if (outcome.report) reports.push(outcome.report);
    current = { script: outcome.script, rows: outcome.rows, refused: refusalsOf(outcome.report) };
  }
  const spelled = safetyNetSpelling(current.script);
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
