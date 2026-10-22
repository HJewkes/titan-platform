/**
 * The round age nudge (TP-4044): a round left open more than six hours with no feedback.json and no withdrawal gets
 * one "reply rec" line, stating each question's recommendation. The inbox lists every due round as one row, read
 * only. The digest (`titan-console rounds nudge`) claims each due round once with a `nudged.json` marker beside it,
 * written with `wx`, so a second digest finds the marker and says nothing; the marker lives on disk, so a restart
 * does not nudge again.
 *
 * A round is offered the one-tap answer only when every question carries a recommendation that answers it and no
 * question is a Ship decision: a Ship merges a PR at a head and is answered on the round page, where its blockers
 * show. The tap goes through `rounds.submit`'s own pipeline (`rounds-submit.ts`).
 */
import path from "node:path";
import type { Manifest, Question } from "./round-schema.js";
import type { SubmittedAnswer } from "./round2-adapter.js";
import { FEEDBACK_FILE, type QueueRound } from "./rounds.js";
import { exists, parseStateJson, readStateFile, writeJsonOnce } from "./state-file.js";
import { z } from "zod";

export const NUDGE_AFTER_MS = 6 * 60 * 60 * 1000;
export const NUDGED_FILE = "nudged.json";
const NUDGED_SCHEMA_ID = "titan-console/nudged@1";
const nudgedSchema = z.object({ schema: z.literal(NUDGED_SCHEMA_ID), at: z.string() });

/** What a round's feedback says in `general` when the one tap answered it, so a seat can tell it from a reading. */
export const ANSWERED_BY_REC = "answered-by-rec: every question was answered with its recommendation from the round nudge";

interface StatedRecommendation {
  questionId: string;
  prompt: string;
  answer: string;
}

export interface RoundNudge {
  roundId: string;
  unit: string;
  round: number;
  openedAt: string;
  manifestSha256: string;
  recommendations: StatedRecommendation[];
  /** True when the one tap may answer every question; otherwise `withoutTap` says why not. */
  oneTap: boolean;
  withoutTap?: string;
  line: string;
  /** When the digest claimed this round, or null while it has not. */
  nudgedAt: string | null;
}

type Recommended = Extract<Question, { recommendation?: unknown }>;

const isRecommendable = (question: Question): question is Recommended => question.kind !== "text";

const statedAnswer = (answer: string | number | readonly string[]): string => (Array.isArray(answer) ? answer.join(", ") : String(answer));

/** The posted answer a question's recommendation makes, or undefined when it does not answer that question. */
function recAnswerOf(question: Question): SubmittedAnswer | undefined {
  if (!isRecommendable(question) || question.recommendation === undefined) return undefined;
  const wanted = question.recommendation.answer;
  const base = { questionId: question.id, recommendationSeen: true as const };
  if (question.kind === "pick-one" && typeof wanted === "string" && question.options.includes(wanted)) return { ...base, pick: wanted };
  if (question.kind === "pick-many" && Array.isArray(wanted) && wanted.every((option) => question.options.includes(option))) return { ...base, picks: wanted };
  if (question.kind === "scale" && typeof wanted === "number" && wanted >= question.min && wanted <= question.max) return { ...base, value: wanted };
  return undefined;
}

const isShip = (question: Question): boolean => question.kind === "pick-one" && question.merge !== undefined;

/** Every question answered with its recommendation, or the reason the round takes no one-tap answer. */
export function recAnswers(manifest: Manifest): { answers: SubmittedAnswer[] } | { reason: string } {
  const ship = manifest.questions.find(isShip);
  if (ship !== undefined) return { reason: `question "${ship.id}" is a Ship decision, answered on the round page` };
  const answers: SubmittedAnswer[] = [];
  for (const question of manifest.questions) {
    const answer = recAnswerOf(question);
    if (answer === undefined) return { reason: `question "${question.id}" has no recommendation that answers it` };
    answers.push(answer);
  }
  return answers.length > 0 ? { answers } : { reason: "the round asks no question" };
}

function statedRecommendations(manifest: Manifest): StatedRecommendation[] {
  return manifest.questions.flatMap((question) =>
    isRecommendable(question) && question.recommendation !== undefined ? [{ questionId: question.id, prompt: question.prompt, answer: statedAnswer(question.recommendation.answer) }] : [],
  );
}

const hoursOpen = (openedAt: string, now: number): number => Math.floor((now - Date.parse(openedAt)) / (60 * 60 * 1000));

function nudgeLine(round: QueueRound, recommendations: readonly StatedRecommendation[], oneTap: boolean, now: number): string {
  const waited = `${round.id} has waited ${hoursOpen(round.updatedAt, now)} h`;
  const stated = recommendations.map(({ questionId, answer }) => `${questionId}: ${answer}`).join("; ");
  if (!oneTap) return `${waited}; open it to answer${stated === "" ? "" : ` (recommended: ${stated})`}`;
  return `${waited}: reply rec to answer all ${round.manifest.questions.length} with the recommendation (${stated})`;
}

/** Strictly over six hours, unanswered and not withdrawn, as the queue read it. */
export const isDue = (round: QueueRound, now: number): boolean => round.feedback === null && round.withdrawn === null && now - Date.parse(round.updatedAt) > NUDGE_AFTER_MS;

export function nudgeOf(round: QueueRound, now: number, nudgedAt: string | null): RoundNudge {
  const recommendations = statedRecommendations(round.manifest);
  const answered = recAnswers(round.manifest);
  const oneTap = "answers" in answered;
  const { unit, round: number } = round.manifest;
  return {
    roundId: round.id, unit, round: number, openedAt: round.updatedAt, manifestSha256: round.manifestSha256, recommendations, oneTap,
    ...("reason" in answered && { withoutTap: answered.reason }),
    line: nudgeLine(round, recommendations, oneTap, now),
    nudgedAt,
  };
}

async function readNudgedAt(roundDir: string): Promise<string | null> {
  return parseStateJson(await readStateFile(path.join(roundDir, NUDGED_FILE)), nudgedSchema)?.at ?? null;
}

/** A feedback.json the queue could not parse still answers the round, so only a truly absent file leaves it due. */
async function dueRounds(dir: string, rounds: readonly QueueRound[], now: number): Promise<QueueRound[]> {
  const due = rounds.filter((round) => isDue(round, now));
  const unanswered = await Promise.all(due.map(async (round) => !(await exists(path.join(dir, round.id, FEEDBACK_FILE)))));
  return due.filter((_, index) => unanswered[index]);
}

/** The inbox's read: every due round, oldest first, with when the digest claimed it. Writes nothing. */
export async function roundNudges(dir: string, rounds: readonly QueueRound[], now: number): Promise<RoundNudge[]> {
  const due = await dueRounds(dir, rounds, now);
  const nudges = await Promise.all(due.map(async (round) => nudgeOf(round, now, await readNudgedAt(path.join(dir, round.id)))));
  return nudges.sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.roundId.localeCompare(b.roundId));
}

/** The digest's pass: claims each due round not yet nudged and returns only those it claimed, so each nudges once. */
export async function claimNudges(dir: string, rounds: readonly QueueRound[], now: Date): Promise<RoundNudge[]> {
  const at = now.toISOString();
  const claimed: RoundNudge[] = [];
  for (const nudge of await roundNudges(dir, rounds, now.getTime())) {
    if (nudge.nudgedAt !== null) continue;
    if (await writeJsonOnce(path.join(dir, nudge.roundId, NUDGED_FILE), { schema: NUDGED_SCHEMA_ID, at })) claimed.push({ ...nudge, nudgedAt: at });
  }
  return claimed;
}
