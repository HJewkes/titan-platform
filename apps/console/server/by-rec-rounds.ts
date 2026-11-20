/**
 * The rounds by-rec sweep (TP-6773, slice D of TP-6765): a round the owner left open past the policy's wait, with every
 * question carrying a recommendation that answers it, is answered with those recommendations. It goes through
 * `rounds.submit`'s own pipeline, as the nudge's one tap does, so the decision log, the listeners and the asker's notice
 * hear it as they hear any answer. The pipeline writes owner-queue's `auto-by-rec` mark into the feedback's `general`
 * (never `answered-by-rec`, which stays the owner's own tap), and every reader takes the answerer from that file: the
 * decisions bullet credits the automation, the decider's ledger gets no row, and the owner queue neither credits the
 * owner nor lets the answer settle another item or lift a change request.
 *
 * Each question is judged by owner-queue's `byRecDecision`, so the exclusion floor applies: an after-answer round (the
 * owner chose to answer it blind), a Ship, a plan approval or a question with no recommendation makes the whole round
 * skip. A round is claimed once per mode with a marker written `wx` beside it before anything else is done, so a second
 * sweep or a restart finds the marker and leaves the round alone. Shadow mode, the default, claims with its own marker
 * and writes would-resolve rows only, so switching to live still answers the rounds shadow saw.
 */
import path from "node:path";
import { BY_REC_RESOLVER, BY_REC_ROW_SCHEMA, byRecDecision, byRecRoundSubject, type ByRecDecision, type ByRecPolicy, type ByRecRecommendation, type ByRecRow, type ByRecSubject } from "@titan-design/owner-queue";
import { appendByRecRows, readByRecPolicy } from "./by-rec-log.js";
import { byRecOpenedAt } from "./by-rec-seen.js";
import { recAnswers } from "./round-nudge.js";
import type { Question } from "./round-schema.js";
import type { SubmittedAnswer } from "./round2-adapter.js";
import { FEEDBACK_FILE, readQueueRounds, type QueueRound } from "./rounds.js";
import type { SubmitPipeline } from "./rounds-submit.js";
import { exists, writeJsonOnce } from "./state-file.js";

export const BY_REC_MARKERS = { live: "auto-by-rec.json", shadow: "auto-by-rec-shadow.json" } as const;
const MARKER_SCHEMA = "titan-console/auto-by-rec-marker@1";
const MAX_TEXT = 500;

type ActiveMode = keyof typeof BY_REC_MARKERS;

interface ByRecRoundOutcome {
  roundId: string;
  result: "resolved" | "would-resolve" | "failed" | "skipped";
  reason?: string;
  /** A skip that only waits: on the clock, or on a claim an earlier sweep made. Not worth a log line. */
  waiting?: boolean;
}

export interface ByRecSweepReport {
  mode: ByRecPolicy["mode"];
  problem?: string;
  outcomes: ByRecRoundOutcome[];
}

interface SweepOptions {
  dir: string;
  stateDir: string;
  submit: SubmitPipeline;
  now: Date;
}

interface Judged {
  question: Question;
  subject: ByRecSubject;
  recommendation: ByRecRecommendation;
  at: string;
}

/** `at` is when the round goes with its recommendations, set on an eligible round and on one waiting only on the clock. */
type RoundVerdict = { eligible: true; at: string; judged: Judged[]; answers: SubmittedAnswer[] } | { eligible: false; reason: string; waiting: boolean; at?: string };

const clip = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);

function judgeQuestion(round: QueueRound, openedAt: string, question: Question, now: Date, policy: ByRecPolicy): ByRecDecision & { subject: ByRecSubject } {
  const planApprovalIds = (round.manifest.planApprovals ?? []).map((binding) => binding.questionId);
  const subject = byRecRoundSubject(question, round.manifest, { roundId: round.id, openedAt, planApprovalIds });
  return { ...byRecDecision(subject, now, policy), subject };
}

const latest = (times: readonly string[]): string => times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));

/**
 * The one by-rec verdict on a round, which the sweep acts on and the inbox's countdown shows. Every question must be
 * eligible, and any refusal other than the clock names the round's skip; a round only waiting on the clock carries the
 * time it will go.
 */
export function byRecRoundVerdict(round: QueueRound, openedAt: string, now: Date, policy: ByRecPolicy): RoundVerdict {
  const decisions = round.manifest.questions.map((question) => ({ question, decision: judgeQuestion(round, openedAt, question, now, policy) }));
  const refused = decisions.find(({ decision }) => !decision.eligible && decision.reason !== "too-early");
  if (refused !== undefined && !refused.decision.eligible) return { eligible: false, reason: `question "${refused.question.id}": ${refused.decision.reason}`, waiting: false };
  const built = recAnswers(round.manifest);
  if ("reason" in built) return { eligible: false, reason: built.reason, waiting: false };
  const at = latest(decisions.flatMap(({ decision }) => (decision.at === undefined ? [] : [decision.at])));
  const early = decisions.find(({ decision }) => !decision.eligible);
  if (early !== undefined) return { eligible: false, reason: `question "${early.question.id}": too-early`, waiting: true, at };
  const judged = decisions.flatMap(({ question, decision }) => (decision.subject.recommendation === undefined ? [] : [{ question, subject: decision.subject, recommendation: decision.subject.recommendation, at: decision.at ?? at }]));
  return { eligible: true, at, judged, answers: built.answers };
}

function rowOf(round: QueueRound, { question, subject, recommendation, at }: Judged, mode: ActiveMode, now: Date, result: ByRecRow["result"], reason?: string): ByRecRow {
  return {
    schema: BY_REC_ROW_SCHEMA,
    subject: { source: "round", id: subject.id, ...(subject.summary && { summary: subject.summary }) },
    recommendation,
    openedAt: subject.openedAt,
    resolvedAt: now.toISOString(),
    facts: { roundId: round.id, questionId: question.id, manifestSha256: round.manifestSha256, eligibleAt: at },
    mode, result, ...(reason && { reason: clip(reason) }),
    resolver: { ...BY_REC_RESOLVER },
  };
}

async function claim(roundDir: string, mode: ActiveMode, now: Date): Promise<boolean> {
  return writeJsonOnce(path.join(roundDir, BY_REC_MARKERS[mode]), { schema: MARKER_SCHEMA, mode, at: now.toISOString(), by: BY_REC_RESOLVER });
}

async function answer(options: SweepOptions, round: QueueRound, answers: SubmittedAnswer[]): Promise<Pick<ByRecRoundOutcome, "result" | "reason">> {
  try {
    const submitted = await options.submit({ id: round.id, manifestSha256: round.manifestSha256, answers }, { byRec: true });
    return submitted.status === "submitted" ? { result: "resolved" } : { result: "skipped", reason: "answered before the sweep reached it" };
  } catch (error) {
    return { result: "failed", reason: error instanceof Error ? error.message : "submit failed" };
  }
}

async function sweepRound(options: SweepOptions, round: QueueRound, policy: ByRecPolicy, mode: ActiveMode): Promise<ByRecRoundOutcome> {
  const verdict = byRecRoundVerdict(round, await byRecOpenedAt(options.stateDir, round, options.now), options.now, policy);
  if (!verdict.eligible) return { roundId: round.id, result: "skipped", reason: verdict.reason, waiting: verdict.waiting };
  if (!(await claim(path.join(options.dir, round.id), mode, options.now))) return { roundId: round.id, result: "skipped", reason: "claimed", waiting: true };
  const done = mode === "shadow" ? { result: "would-resolve" as const } : await answer(options, round, verdict.answers);
  await appendByRecRows(options.stateDir, verdict.judged.map((judged) => rowOf(round, judged, mode, options.now, done.result, done.reason)));
  return { roundId: round.id, ...done };
}

/** Open as the queue reads it and with no feedback.json at all: one the queue could not parse still answers the round. */
export async function openRounds(dir: string): Promise<QueueRound[]> {
  const candidates = (await readQueueRounds({ dir })).rounds.filter((round) => round.manifest.kind !== "feedback" && round.feedback === null && round.withdrawn === null);
  const unanswered = await Promise.all(candidates.map(async (round) => !(await exists(path.join(dir, round.id, FEEDBACK_FILE)))));
  return candidates.filter((_, index) => unanswered[index]);
}

/** One pass: reads the policy afresh, so `mode: off` in the file stops the next pass. */
export async function sweepByRecRounds(options: SweepOptions): Promise<ByRecSweepReport> {
  const { policy, problem } = await readByRecPolicy(options.stateDir);
  const { mode } = policy;
  if (mode === "off") return { mode, ...(problem && { problem }), outcomes: [] };
  const outcomes: ByRecRoundOutcome[] = [];
  for (const round of await openRounds(options.dir)) outcomes.push(await sweepRound(options, round, policy, mode));
  return { mode, outcomes };
}
