import type { ConsoleCommands } from "../../server/commands.js";
import type { Manifest, Question } from "../../server/round-schema.js";
import type { QuestionAnswer } from "./RoundQuestion.js";

type SubmittedAnswer = ConsoleCommands["rounds.submit"]["args"]["answers"][number];

/** An empty pick-many or blank text is no answer. */
function heldAnswer(answer: QuestionAnswer | undefined): QuestionAnswer | undefined {
  if (answer === undefined) return undefined;
  if ("picks" in answer && answer.picks.length === 0) return undefined;
  if ("text" in answer && answer.text.trim() === "") return undefined;
  return answer;
}

/** The page's answers as `rounds.submit` takes them; a comment is sent with or without an answer beside it. */
export function submittedAnswers(questions: readonly Question[], answers: Record<string, QuestionAnswer>, comments: Record<string, string> = {}): SubmittedAnswer[] {
  return questions.flatMap((question): SubmittedAnswer[] => {
    const answer = heldAnswer(answers[question.id]);
    const comment = comments[question.id]?.trim() ?? "";
    if (answer === undefined && comment === "") return [];
    return [{ questionId: question.id, ...answer, ...(comment ? { comment } : {}) }];
  });
}

export const inOrder = (manifest: Manifest, answers: SubmittedAnswer[]): SubmittedAnswer[] => {
  const order = manifest.questions.map((question) => question.id);
  return [...answers].sort((left, right) => order.indexOf(left.questionId) - order.indexOf(right.questionId));
};

const answers = (answer: SubmittedAnswer): boolean => answer.pick !== undefined || answer.picks !== undefined || answer.value !== undefined || answer.text !== undefined;

/** The required questions the page holds no answer for, which block a send; a comment alone answers nothing. */
export const missingRequired = (questions: readonly Question[], submitted: readonly SubmittedAnswer[]): Question[] =>
  questions.filter((question) => question.required && !submitted.some((answer) => answer.questionId === question.id && answers(answer)));
