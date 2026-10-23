import { optionText, OWNER_LABELS } from "./calibration-agreement.js";
import type { CalibrationQueue, QueueItem } from "./calibration-queue.js";

/** About how long one item takes: read the excerpt, answer one yes or no question. */
export const MINUTES_PER_ITEM = 1.75;

/** A video as the owner reads it once, before its items. */
export interface RoundCase {
  title: string;
  /** The script as spoken, chapter by chapter; the rubric items judge all of it. */
  script: string;
}

interface RoundOptions {
  unit: string;
  cases: ReadonlyMap<string, RoundCase>;
}

const question = (item: QueueItem) => ({
  id: item.id,
  kind: "pick-one" as const,
  required: false,
  prompt: `${item.question}\n\n${item.excerpt}`,
  options: OWNER_LABELS.map((label) => optionText(label, item.id)),
  signsOff: `your label for item ${item.id}`,
});

function section(caseId: string, items: readonly QueueItem[], video: RoundCase | undefined) {
  return {
    id: `case-${caseId.replace(/[^a-z0-9-]/gi, "-")}`,
    title: video?.title ?? caseId,
    questionIds: items.map((item) => item.id),
    variantKeys: [],
    deciding: "Yes or No to each question, from the excerpt (or the script below for whole-video questions). Can't tell when it does not settle it.",
    changed: "Nothing ships from this round; your labels only score the judges, whose own answers stay hidden.",
    context: video?.script ?? "(script not attached)",
  };
}

/**
 * A titan-review/round@2 questions-only round. Blind: no recommendation, and nothing names the judge or its verdict.
 * Questions are optional, so the page adds no "request a revision" choice and a skipped item is just unlabelled.
 */
export function calibrationRound(queue: CalibrationQueue, options: RoundOptions) {
  const cases = [...new Set(queue.items.map((item) => item.case))];
  const minutes = Math.round(queue.items.length * MINUTES_PER_ITEM);
  return {
    schema: "titan-review/round@2",
    unit: options.unit,
    round: 1,
    storybookUrl: "http://127.0.0.1:6006",
    widths: [1280],
    context:
      `Judge calibration (TP-4012): ${queue.items.length} yes or no questions from ${cases.length} videos, about ${minutes} minutes. ` +
      "Each question is one a model judge already answered; your answers say how often each judge agrees with you. " +
      "Until a judge reaches 0.8 agreement it stays reported only and is never a climb target or a gate.",
    variants: [],
    sections: cases.map((c) => section(c, queue.items.filter((item) => item.case === c), options.cases.get(c))),
    questions: queue.items.map(question),
    recommendations: "after-answer",
  };
}
