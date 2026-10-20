/**
 * What keeps a Ship round from shipping (TP-3741): earlier feedback on the same unit that the owner has not
 * ticked as addressed, and any change request in the answer being sent (owner item 166: free text, or a
 * pick that differs from the implemented choice). The page disables Ship for these reasons and
 * `rounds.submit` refuses a Ship pick for the same ones, so this module imports types only and runs in both.
 * An answer the owner marks follow-up (TP-3346) is filed for later instead, so it never blocks.
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

export interface DraftAnswer {
  questionId: string;
  pick?: string;
  revisionRequested?: true;
  picks?: string[];
  comment?: string;
}

/** The answer about to be sent: every answer with its comment, the round note, the rounds ticked Addressed and the follow-ups. */
interface ShipDraft {
  answers: readonly DraftAnswer[];
  general: string;
  addressed: readonly number[];
  /** The side questions marked follow-up; absent is none. */
  followUps?: readonly string[];
}

interface EarlierRound {
  manifest: Manifest;
  feedback: Feedback | null;
  /** The questions that round filed as follow-ups, whose comments are not this PR's to address. */
  followUps?: readonly string[];
}

type PickOne = Extract<Question, { kind: "pick-one" }>;
type MergeQuestion = PickOne & { merge: NonNullable<PickOne["merge"]> };

const isMerge = (question: Question): question is MergeQuestion => question.kind === "pick-one" && question.merge !== undefined;
const blank = (text: string | undefined): boolean => (text ?? "").trim() === "";

function mergeAnswer(manifest: Manifest, feedback: Feedback) {
  const question = manifest.questions.find(isMerge);
  const answer = question && feedback.answers.find((each) => each.questionId === question.id);
  return { answer, ship: question?.merge.ship ?? [] };
}

/** The merge question's comment first, as it is the one a Send back carries. */
function commentsOf(feedback: Feedback, mergeId: string | undefined, followUps: readonly string[]): string[] {
  const ordered = feedback.answers.filter((answer) => !followUps.includes(answer.questionId)).sort((left, right) => Number(right.questionId === mergeId) - Number(left.questionId === mergeId));
  return ordered.flatMap((answer) => (blank(answer.comment) ? [] : [answer.comment ?? ""]));
}

function feedbackItem({ manifest, feedback, followUps = [] }: EarlierRound & { feedback: Feedback }): PriorFeedback | null {
  const { answer, ship } = mergeAnswer(manifest, feedback);
  const pick = answer?.pick !== undefined && !ship.includes(answer.pick) ? answer.pick : undefined;
  const comment = commentsOf(feedback, answer?.questionId, followUps).join("\n\n");
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
    .flatMap(({ manifest: earlier, feedback, followUps }) =>
      earlier.unit === manifest.unit && earlier.round < manifest.round && feedback !== null ? [feedbackItem({ manifest: earlier, feedback, followUps })] : [],
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

/** Why this one answer would keep the round from shipping; empty when it is informational. */
export function answerBlockers(manifest: Manifest, answer: DraftAnswer): string[] {
  const question = manifest.questions.find((each) => each.id === answer.questionId);
  if (question === undefined) return [];
  const expected = isMerge(question) ? undefined : expectedChoice(manifest, question);
  return [
    ...(blank(answer.comment) ? [] : [`you left a comment on "${question.prompt}"`]),
    ...(expected !== undefined && differs(expected, answer) ? [`your answer to "${question.prompt}" differs from the implemented choice`] : []),
  ];
}

/** What on a side question blocks Ship: a pick-one's other options, a pick-many's every set but one, else only a comment. */
type ShipStake = { kind: "picks"; blocking: string[] } | { kind: "set"; expected: readonly string[] } | { kind: "comment" };

export function shipStake(manifest: Manifest, question: Question): ShipStake {
  const expected = isMerge(question) ? undefined : expectedChoice(manifest, question);
  if (expected === undefined) return { kind: "comment" };
  if (question.kind === "pick-many") return { kind: "set", expected };
  const options = question.kind === "pick-one" ? question.options : [];
  return { kind: "picks", blocking: options.filter((option) => !expected.includes(option)) };
}

const pageOf = (question: MergeQuestion): string => `${question.merge.repo}#${question.merge.pr}`;

/**
 * The questions whose answers bear on shipping one merge question: in a round with several (TP-3329), its own PR group's and
 * those no group claims, never another PR's; in a round with one, every question.
 */
export function shipScope(manifest: Manifest, mergeId: string): ReadonlySet<string> {
  const merges = manifest.questions.filter(isMerge);
  const all = new Set(manifest.questions.map((question) => question.id));
  const merge = merges.find((question) => question.id === mergeId);
  if (merges.length < 2 || merge === undefined || manifest.prGroups === undefined) return all;
  const groupOf = new Map(manifest.prGroups.flatMap((group) => group.sectionIds.map((sectionId) => [sectionId, group.pr] as const)));
  const claimedBy = new Map(manifest.sections.flatMap((section) => section.questionIds.map((id) => [id, groupOf.get(section.id)] as const)));
  const own = pageOf(merge);
  return new Set([...all].filter((id) => (claimedBy.get(id) ?? own) === own && (id === mergeId || !merges.some((other) => other.id === id))));
}

const NEEDS_NOTE = "Send back needs a note: say what to fix in the Ship comment or the round note.";

/**
 * Why one PR's Send back is off; undefined when it may go. The fixer's note is the round note and the comment
 * on that PR's own Ship question, and the factory refuses an empty one, so Send back waits for one of them
 * (owner decision 513). A note on another PR's Ship question does not count, and unanswered side questions
 * go with it as unanswered.
 */
export function sendBackBlocker(draft: Pick<ShipDraft, "answers" | "general">, mergeId: string): string | undefined {
  const note = draft.answers.find((answer) => answer.questionId === mergeId)?.comment;
  return blank(note) && blank(draft.general) ? NEEDS_NOTE : undefined;
}

/** Why Ship is off, in plain words; empty when it may ship. Given `mergeId`, only that PR's answers count (`shipScope`). */
export function shipBlockers(manifest: Manifest, prior: readonly PriorFeedback[], draft: ShipDraft, mergeId?: string): string[] {
  const open = [...new Set(prior.filter((item) => !draft.addressed.includes(item.round)).map((item) => item.round))];
  const scope = mergeId === undefined ? undefined : shipScope(manifest, mergeId);
  const thisPr = draft.answers.filter((answer) => !(draft.followUps ?? []).includes(answer.questionId) && (scope?.has(answer.questionId) ?? true));
  return [
    ...open.map((round) => `your feedback from round ${round} is not ticked Addressed`),
    ...thisPr.flatMap((answer) => answerBlockers(manifest, answer)),
    ...(blank(draft.general) ? [] : ["you left feedback on this round"]),
  ];
}
