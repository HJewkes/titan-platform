/**
 * The shape checks `rounds.submit` runs on a posted answer before building its feedback: each answer fits its
 * question, each follow-up names a side question once, and each posted frame and pin belongs to the round.
 */
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { isPinOf } from "./round-feedback.js";
import type { Manifest, Question } from "./round-schema.js";
import type { PostedVariant, SubmittedAnswer } from "./round2-adapter.js";

const refuse = (message: string): never => {
  throw failure(message, EXIT.DATAERR);
};

/** Each field an answer may carry, by the question kinds that take it; `comment` and `optionNotes` go anywhere. */
const FIELD_KINDS: Record<string, readonly string[]> = {
  pick: ["pick-one"],
  revisionRequested: ["pick-one"],
  picks: ["pick-many"],
  value: ["scale"],
  text: ["text"],
};

function answerProblem(question: Question, answer: SubmittedAnswer): string | null {
  const misplaced = Object.keys(answer).find((field) => FIELD_KINDS[field] && !FIELD_KINDS[field].includes(question.kind));
  if (misplaced) return `${misplaced} does not answer a ${question.kind} question`;
  if (answer.pick !== undefined && answer.revisionRequested) return "a revision request carries no pick";
  const offered = "options" in question ? question.options : [];
  const chosen = [...(answer.pick === undefined ? [] : [answer.pick]), ...(answer.picks ?? [])];
  const unknown = chosen.find((option) => !offered.includes(option));
  return unknown === undefined ? null : `"${unknown}" is not one of its options`;
}

/** A follow-up names a side question once; the merge question is the PR's own answer, never a follow-up. */
export function checkFollowUps(manifest: Manifest, followUps: readonly string[]): void {
  const questions = new Map(manifest.questions.map((question) => [question.id, question]));
  for (const [index, id] of followUps.entries()) {
    const question = questions.get(id) ?? refuse(`no question "${id}" to mark follow-up`);
    if (question.kind === "pick-one" && question.merge) refuse(`question "${id}" is the Ship decision and cannot be a follow-up`);
    if (followUps.indexOf(id) !== index) refuse(`question "${id}" is marked follow-up twice`);
  }
}

export function checkAnswers(manifest: Manifest, answers: SubmittedAnswer[]): void {
  const questions = new Map(manifest.questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = questions.get(answer.questionId) ?? refuse(`no question "${answer.questionId}" in this round`);
    if (seen.has(answer.questionId)) refuse(`question "${answer.questionId}" is answered twice`);
    seen.add(answer.questionId);
    const problem = answerProblem(question, answer);
    if (problem !== null) refuse(`question "${answer.questionId}": ${problem}`);
  }
}

/** Each posted frame is one of the round's, once, and each of its pins is numbered on that frame. */
export function checkVariants(manifest: Manifest, variants: readonly PostedVariant[]): void {
  const keys = new Set(manifest.variants.map((variant) => variant.key));
  const seen = new Set<string>();
  for (const { key, annotations = [] } of variants) {
    if (!keys.has(key)) refuse(`no frame "${key}" in this round`);
    if (seen.has(key)) refuse(`frame "${key}" is sent twice`);
    seen.add(key);
    const stray = annotations.find((pin, index) => !isPinOf(key, pin.id) || annotations.findIndex((each) => each.id === pin.id) !== index);
    if (stray !== undefined) refuse(`frame "${key}": pin "${stray.id}" is not a pin of its own, numbered once`);
  }
}
