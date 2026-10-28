import { createHash } from "node:crypto";
import { optionText, OWNER_LABELS } from "./calibration-agreement.js";
import type { CalibrationQueue, ItemKind, QueueItem } from "./calibration-queue.js";

/** About how long one item takes: read an excerpt and answer yes or no, or read two storyboards and pick one. */
const MINUTES_PER_ITEM: Record<ItemKind, number> = { verdict: 1.25, pair: 2, listener: 1.25 };

export const roundMinutes = (items: readonly QueueItem[]): number => Math.round(items.reduce((total, item) => total + MINUTES_PER_ITEM[item.kind], 0));

/** A video as the owner reads it once, before its items. */
export interface RoundCase {
  title: string;
  /** The script as spoken, chapter by chapter; the rubric items judge all of it. */
  script: string;
}

interface RoundOptions {
  unit: string;
  round: number;
  cases: ReadonlyMap<string, RoundCase>;
}

const question = (item: QueueItem) => ({
  id: item.id,
  kind: "pick-one" as const,
  required: false,
  prompt: `${item.question}\n\n${item.excerpt}`,
  options: OWNER_LABELS.map((label) => optionText(label, item.id, item.kind)),
  signsOff: `your label for item ${item.id}`,
});

const CONSOLE_ID_MAX = 32;
const HASH_LENGTH = 8;

/**
 * The console accepts section ids of 1 to 32 of letters, digits, `_` and `-`. A long case keeps a readable prefix and
 * ends in a hash of the whole case, so the same case always gets the same id and cases sharing a prefix differ.
 */
export function sectionId(caseId: string): string {
  const slug = `case-${caseId.replace(/[^a-z0-9-]/gi, "-")}`;
  if (slug.length <= CONSOLE_ID_MAX) return slug;
  const hash = createHash("sha256").update(caseId).digest("hex").slice(0, HASH_LENGTH);
  return `${slug.slice(0, CONSOLE_ID_MAX - HASH_LENGTH - 1)}-${hash}`;
}

function section(caseId: string, items: readonly QueueItem[], video: RoundCase | undefined) {
  return {
    id: sectionId(caseId),
    title: video?.title ?? caseId,
    questionIds: items.map((item) => item.id),
    variantKeys: [],
    deciding: items.every((item) => item.kind === "pair")
      ? "A or B for each pair of storyboards. Can't tell when neither is the better video."
      : "Yes or No to each question, from the excerpt (or the script below for whole-video questions). Can't tell when it does not settle it.",
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
  const minutes = roundMinutes(queue.items);
  return {
    schema: "titan-review/round@2",
    unit: options.unit,
    round: options.round,
    storybookUrl: "http://127.0.0.1:6006",
    widths: [1280],
    context:
      `Judge calibration (TP-4012): ${queue.items.length} questions in ${cases.length} sections, about ${minutes} minutes. ` +
      "Each question is one a model judge already answered; your answers say how often each judge agrees with you. " +
      "The clearest material comes first and every question is optional, so you can stop anywhere and what you answered still counts. " +
      "Until a judge reaches 0.8 agreement it stays reported only and is never a climb target or a gate.",
    variants: [],
    sections: cases.map((c) => section(c, queue.items.filter((item) => item.case === c), options.cases.get(c))),
    questions: queue.items.map(question),
    recommendations: "after-answer",
  };
}
