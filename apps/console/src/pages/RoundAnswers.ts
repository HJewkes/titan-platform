import type { ConsoleCommands } from "../../server/commands.js";
import type { Manifest, Question } from "../../server/round-schema.js";
import type { QuestionAnswer } from "./RoundQuestion.js";

type SubmittedAnswer = ConsoleCommands["rounds.submit"]["args"]["answers"][number];

/** The page's answers as `rounds.submit` takes them; an empty pick-many or blank text is no answer. */
export function submittedAnswers(questions: readonly Question[], answers: Record<string, QuestionAnswer>): SubmittedAnswer[] {
  return questions.flatMap((question): SubmittedAnswer[] => {
    const answer = answers[question.id];
    if (answer === undefined) return [];
    if ("picks" in answer && answer.picks.length === 0) return [];
    if ("text" in answer && answer.text.trim() === "") return [];
    return [{ questionId: question.id, ...answer }];
  });
}

export const inOrder = (manifest: Manifest, answers: SubmittedAnswer[]): SubmittedAnswer[] => {
  const order = manifest.questions.map((question) => question.id);
  return [...answers].sort((left, right) => order.indexOf(left.questionId) - order.indexOf(right.questionId));
};

/** The required questions the page holds no answer for, which block a send. */
export const missingRequired = (questions: readonly Question[], answers: readonly SubmittedAnswer[]): Question[] =>
  questions.filter((question) => question.required && !answers.some((answer) => answer.questionId === question.id));
