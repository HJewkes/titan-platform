/**
 * A submitted round answer as the decision log's item and answer. It follows owner-queue's
 * round items (same id, source ref and answerer) without parsing through its pinned review-schema,
 * which refuses the feedback@1 fields `rounds.submit` writes. A merge-bound question approves a
 * head, so a Ship stays out of the decisions file; any other question with options is a decide.
 */
import { ROUND_ANSWERER, roundItemId } from "@titan-design/owner-queue";
import type { DecisionAnswer, DecisionItem } from "./decision-log.js";
import type { Manifest, Question } from "./round-schema.js";
import type { SubmittedAnswer } from "./round2-adapter.js";

interface RoundDecision {
  questionId: string;
  item: DecisionItem;
  answer: DecisionAnswer;
}

export interface SubmittedRound {
  roundId: string;
  manifest: Manifest;
  answers: readonly SubmittedAnswer[];
  /** When round.json was last written; round@2 carries no time of its own. */
  openedAt: string;
  submittedAt: string;
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;

const labelsOf = (question: Question): readonly string[] => ("options" in question ? question.options : []);

function optionsOf(question: Question): DecisionItem["options"] {
  const labels = labelsOf(question);
  if (labels.length < MIN_OPTIONS || labels.length > MAX_OPTIONS) return undefined;
  return labels.map((label) => ({ id: label, label }));
}

function recommendedOf(question: Question): DecisionItem["recommended"] {
  if (question.kind === "text" || question.recommendation === undefined) return undefined;
  const { answer, by } = question.recommendation;
  return typeof answer === "string" && labelsOf(question).includes(answer) ? { optionId: answer, by } : undefined;
}

function itemOf(question: Question, { roundId, openedAt }: SubmittedRound): DecisionItem {
  const options = optionsOf(question);
  const recommended = recommendedOf(question);
  return {
    id: roundItemId(roundId, question.id),
    sources: [{ system: "round", ref: `${roundId}#${question.id}` }],
    kind: question.kind === "pick-one" && question.merge !== undefined ? "approve" : options === undefined ? "review" : "decide",
    door: "two-way",
    summary: question.prompt.replace(/\s+/g, " ").trim(),
    ...(options === undefined ? {} : { options }),
    ...(recommended === undefined ? {} : { recommended }),
    keys: [],
    personal: false,
    openedAt,
  };
}

/** Null for an answer that only comments, which records no choice. */
function answerOf(answer: SubmittedAnswer, at: string): DecisionAnswer | null {
  const given = answer.text ?? (answer.value === undefined ? undefined : String(answer.value));
  const text = [given, answer.comment].filter((part): part is string => !!part?.trim()).join("\n") || undefined;
  const choice = answer.picks !== undefined ? { optionIds: answer.picks } : answer.pick !== undefined ? { optionId: answer.pick } : {};
  const changeRequested = answer.revisionRequested === true;
  if (Object.keys(choice).length === 0 && given === undefined && !changeRequested) return null;
  return { ...choice, ...(text === undefined ? {} : { text }), ...(changeRequested ? { changeRequested } : {}), by: ROUND_ANSWERER, at };
}

/** One decision per answered question, in answer order. */
export function roundDecisions(submitted: SubmittedRound): RoundDecision[] {
  return submitted.answers.flatMap((submittedAnswer) => {
    const question = submitted.manifest.questions.find((each) => each.id === submittedAnswer.questionId);
    const answer = answerOf(submittedAnswer, submitted.submittedAt);
    if (question === undefined || answer === null) return [];
    return [{ questionId: question.id, item: itemOf(question, submitted), answer }];
  });
}
