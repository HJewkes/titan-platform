import type { ConsoleCommands } from "../../server/commands.js";
import type { Manifest, Question } from "../../server/round-schema.js";
import type { RoundNotes, SentAnswer } from "../../server/rounds.js";
import type { QuestionAnswer } from "./RoundQuestion.js";

type SubmittedAnswer = ConsoleCommands["rounds.submit"]["args"]["answers"][number];

/** An empty pick-many or blank text is no answer. */
function heldAnswer(answer: QuestionAnswer | undefined): QuestionAnswer | undefined {
  if (answer === undefined) return undefined;
  if ("picks" in answer && answer.picks.length === 0) return undefined;
  if ("text" in answer && answer.text.trim() === "") return undefined;
  return answer;
}

/** The non-blank notes on a question's options, in option order. */
function notesOn(question: Question, notes: Record<string, string> = {}): NonNullable<SubmittedAnswer["optionNotes"]> {
  const options = "options" in question ? question.options : [];
  return options.flatMap((option) => (notes[option]?.trim() ? [{ option, note: notes[option].trim() }] : []));
}

/** The page's answers as `rounds.submit` takes them; a comment or option note is sent with or without an answer beside it. */
export function submittedAnswers(
  questions: readonly Question[],
  answers: Record<string, QuestionAnswer>,
  comments: Record<string, string> = {},
  optionNotes: Record<string, Record<string, string>> = {},
): SubmittedAnswer[] {
  return questions.flatMap((question): SubmittedAnswer[] => {
    const answer = heldAnswer(answers[question.id]);
    const comment = comments[question.id]?.trim() ?? "";
    const notes = notesOn(question, optionNotes[question.id]);
    if (answer === undefined && comment === "" && notes.length === 0) return [];
    return [{ questionId: question.id, ...answer, ...(comment ? { comment } : {}), ...(notes.length > 0 ? { optionNotes: notes } : {}) }];
  });
}

function heldOf(sent: SentAnswer): QuestionAnswer | undefined {
  if (sent.revisionRequested) return { revisionRequested: true };
  if (sent.pick !== undefined) return { pick: sent.pick };
  if (sent.picks !== undefined) return { picks: sent.picks };
  if (sent.value !== undefined) return { value: sent.value };
  return sent.text === undefined ? undefined : { text: sent.text };
}

/** A sent round's answers, comments and option notes as the page holds them, so a reload shows what was sent (TP-3767). */
export function heldFromSent(notes: RoundNotes | undefined) {
  const sent = Object.entries(notes?.answers ?? {});
  const answers = Object.fromEntries(
    sent.flatMap(([questionId, answer]) => {
      const held = heldOf(answer);
      return held === undefined ? [] : [[questionId, held] as const];
    }),
  );
  const optionNotes = Object.fromEntries(sent.map(([questionId, answer]) => [questionId, Object.fromEntries((answer.optionNotes ?? []).map(({ option, note }) => [option, note]))]));
  return { answers, comments: { ...notes?.comments }, optionNotes, general: notes?.general ?? "" };
}

export const inOrder =(manifest: Manifest, answers: SubmittedAnswer[]): SubmittedAnswer[] => {
  const order = manifest.questions.map((question) => question.id);
  return [...answers].sort((left, right) => order.indexOf(left.questionId) - order.indexOf(right.questionId));
};

/** A revision request answers only once its comment says what to change, as feedback@1 requires. */
const answers = (answer: SubmittedAnswer): boolean =>
  answer.pick !== undefined || answer.picks !== undefined || answer.value !== undefined || answer.text !== undefined || (answer.revisionRequested === true && answer.comment !== undefined);

/** The questions the page holds no answer for; a comment alone answers nothing. */
export const unanswered = (questions: readonly Question[], submitted: readonly SubmittedAnswer[]): Question[] =>
  questions.filter((question) => !submitted.some((answer) => answer.questionId === question.id && answers(answer)));

/** The required questions the page holds no answer for, which block a send. */
export const missingRequired = (questions: readonly Question[], submitted: readonly SubmittedAnswer[]): Question[] =>
  unanswered(questions.filter((question) => question.required), submitted);
