import type { ConsoleCommands } from "../../server/commands.js";
import type { Manifest, Question } from "../../server/round-schema.js";
import { asksRevision, unanswered } from "./RoundAnswers.js";
import { orderedQuestions } from "./RoundSections.js";
import type { PostedVariant, VERDICTS } from "./frame-feedback.js";
import type { Pin } from "./frame-pins.js";
import { sectionPages } from "./round-pages.js";

type SubmittedAnswer = ConsoleCommands["rounds.submit"]["args"]["answers"][number];

/** One question as the check screen lists it: what the send would carry for it, and whether that answers it. */
export interface CheckRow {
  question: Question;
  position: number;
  answer: SubmittedAnswer | undefined;
  open: boolean;
}

/** A frame the send carries a verdict, comment or pins for, under its variant's label. */
export type CheckVerdict = (typeof VERDICTS)[number]["verdict"];

export interface CheckFrame {
  key: string;
  label: string;
  verdict?: CheckVerdict;
  comment?: string;
  annotations?: readonly Pin[];
}

/** One section of the check screen, in the pager's order. */
export interface CheckGroup {
  id: string;
  title: string;
  rows: CheckRow[];
  frames: CheckFrame[];
}

/** The round's answers and frame verdicts grouped as the pager pages them, so a row names the page it is answered on. */
export function checkGroups(manifest: Manifest, submitted: readonly SubmittedAnswer[], variants: readonly PostedVariant[] = []): CheckGroup[] {
  const pages = sectionPages(orderedQuestions(manifest));
  const all = pages.flatMap((page) => page.questions);
  const open = unanswered(all, submitted);
  const labels = new Map(manifest.variants.map((variant) => [variant.key, variant.label]));
  const framesOf = (keys: ReadonlySet<string>): CheckFrame[] => variants.filter((variant) => keys.has(variant.key)).map((variant) => ({ ...variant, label: labels.get(variant.key) ?? variant.key }));
  return pages.map((page): CheckGroup => {
    const section = manifest.sections.find((each) => each.id === page.id);
    const rows = page.questions.map((question) => ({ question, position: all.indexOf(question) + 1, answer: submitted.find((answer) => answer.questionId === question.id), open: open.includes(question) }));
    return { id: page.id, title: page.title, rows, frames: framesOf(new Set(section?.variantKeys)) };
  });
}

/** An option names a frame by its variant key, so it reads as the key and the frame's label, as the harness's did. */
const optionLabel = (manifest: Manifest, option: string): string => {
  const label = manifest.variants.find((variant) => variant.key === option)?.label;
  return label === undefined ? option : `${option} · ${label}`;
};

/** What a row says the send carries for its question; a comment alone is no answer. */
export function answerText(manifest: Manifest, answer: SubmittedAnswer | undefined): string | undefined {
  if (answer === undefined) return undefined;
  if (answer.revisionRequested) return "Revision requested";
  if (answer.pick !== undefined) return optionLabel(manifest, answer.pick);
  if (answer.picks !== undefined) return answer.picks.map((pick: string) => optionLabel(manifest, pick)).join(", ");
  if (answer.value !== undefined) return String(answer.value);
  return answer.text;
}

/**
 * What `rounds.submit` would refuse even as a partial send: a revision request with no comment saying what to change.
 * The check screen lists these and holds the send until they are fixed.
 */
export function sendProblems(questions: readonly Question[], submitted: readonly SubmittedAnswer[]): string[] {
  return questions.flatMap((question) => {
    const answer = submitted.find((each) => each.questionId === question.id);
    return asksRevision(question, answer) && !answer?.comment ? [`Say what to change in the comment on "${question.prompt}": a revision request needs one.`] : [];
  });
}

/** The first question still open, in round order: where "Next unanswered" lands. */
export const firstOpen = (groups: readonly CheckGroup[]): Question | undefined => groups.flatMap((group) => group.rows).find((row) => row.open)?.question;
