/**
 * What keeps a Ship round from shipping (TP-3741): earlier feedback on the same unit that the owner has not
 * ticked as addressed, and any change request in the answer being sent (owner item 166: free text, or a
 * pick that differs from the implemented choice). The page disables Ship for these reasons and
 * `rounds.submit` refuses a Ship pick for the same ones, so this module imports types only and runs in both.
 */
import type { Feedback, Manifest, Question } from "./round-schema.js";

/** One earlier round's feedback, verbatim: its non-Ship pick, comments and round note. */
export interface PriorFeedback {
  round: number;
  submittedAt: string;
  pick?: string;
  revisionRequested?: true;
  comment?: string;
  general?: string;
}

interface DraftAnswer {
  questionId: string;
  pick?: string;
  revisionRequested?: true;
  picks?: string[];
  comment?: string;
}

/** The answer about to be sent: every answer with its comment, the round note, and the rounds ticked Addressed. */
export interface ShipDraft {
  answers: readonly DraftAnswer[];
  general: string;
  addressed: readonly number[];
}

interface EarlierRound {
  manifest: Manifest;
  feedback: Feedback | null;
}

type MergeQuestion = Extract<Question, { kind: "pick-one" }> & { merge: object };

const isMerge = (question: Question): question is MergeQuestion => question.kind === "pick-one" && question.merge !== undefined;
const blank = (text: string | undefined): boolean => (text ?? "").trim() === "";

function mergeAnswer(manifest: Manifest, feedback: Feedback) {
  const question = manifest.questions.find(isMerge);
  const answer = question && feedback.answers.find((each) => each.questionId === question.id);
  return { answer, ship: question?.merge?.ship ?? [] };
}

/** The merge question's comment first, as it is the one a Send back carries. */
function commentsOf(feedback: Feedback, mergeId: string | undefined): string[] {
  const ordered = [...feedback.answers].sort((left, right) => Number(right.questionId === mergeId) - Number(left.questionId === mergeId));
  return ordered.flatMap((answer) => (blank(answer.comment) ? [] : [answer.comment ?? ""]));
}

function feedbackItem(manifest: Manifest, feedback: Feedback): PriorFeedback | null {
  const { answer, ship } = mergeAnswer(manifest, feedback);
  const pick = answer?.pick !== undefined && !ship.includes(answer.pick) ? answer.pick : undefined;
  const comment = commentsOf(feedback, answer?.questionId).join("\n\n");
  const item: PriorFeedback = {
    round: manifest.round,
    submittedAt: feedback.submittedAt,
    ...(pick !== undefined && { pick }),
    ...(answer?.revisionRequested && { revisionRequested: true as const }),
    ...(comment !== "" && { comment }),
    ...(!blank(feedback.general) && { general: feedback.general }),
  };
  return Object.keys(item).length > 2 ? item : null;
}

/** Earlier sent rounds of the same unit that asked for anything but a plain Ship, oldest first. */
export function priorFeedback(manifest: Manifest, rounds: readonly EarlierRound[]): PriorFeedback[] {
  return rounds
    .flatMap(({ manifest: earlier, feedback }) =>
      earlier.unit === manifest.unit && earlier.round < manifest.round && feedback !== null ? [feedbackItem(earlier, feedback)] : [],
    )
    .filter((item): item is PriorFeedback => item !== null)
    .sort((left, right) => left.round - right.round || left.submittedAt.localeCompare(right.submittedAt));
}

/** What a side pick must match to ship: what the PR implements, else a recommendation the page already shows. */
function expectedChoice(manifest: Manifest, question: Question): readonly string[] | undefined {
  if (question.kind !== "pick-one" && question.kind !== "pick-many") return undefined;
  if (question.implemented !== undefined) return [question.implemented].flat();
  const recommended = manifest.recommendations === "shown" ? question.recommendation?.answer : undefined;
  return typeof recommended === "string" || Array.isArray(recommended) ? [recommended].flat() : undefined;
}

function differs(expected: readonly string[], answer: DraftAnswer): boolean {
  if (answer.revisionRequested) return true;
  if (answer.pick !== undefined) return !expected.includes(answer.pick);
  if (answer.picks === undefined) return false;
  return answer.picks.length !== expected.length || answer.picks.some((pick) => !expected.includes(pick));
}

function answerBlockers(manifest: Manifest, answer: DraftAnswer): string[] {
  const question = manifest.questions.find((each) => each.id === answer.questionId);
  if (question === undefined) return [];
  const expected = isMerge(question) ? undefined : expectedChoice(manifest, question);
  return [
    ...(blank(answer.comment) ? [] : [`you left a comment on "${question.prompt}"`]),
    ...(expected !== undefined && differs(expected, answer) ? [`your answer to "${question.prompt}" differs from the implemented choice`] : []),
  ];
}

/** Why Ship is off, in plain words; empty when it may ship. */
export function shipBlockers(manifest: Manifest, prior: readonly PriorFeedback[], draft: ShipDraft): string[] {
  const open = [...new Set(prior.filter((item) => !draft.addressed.includes(item.round)).map((item) => item.round))];
  return [
    ...open.map((round) => `your feedback from round ${round} is not ticked Addressed`),
    ...draft.answers.flatMap((answer) => answerBlockers(manifest, answer)),
    ...(blank(draft.general) ? [] : ["you left feedback on this round"]),
  ];
}
