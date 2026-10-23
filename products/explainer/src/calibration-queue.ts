import { createHash } from "node:crypto";
import { z } from "zod";

/** The model judges the owner's labels calibrate: the cold probe, the cold-viewer rubric (J8 to J12) and L1. */
export const CALIBRATION_JUDGES = ["cold", "cold-rubric", "l1"] as const;
export type CalibrationJudge = (typeof CALIBRATION_JUDGES)[number];

/** The design's bar (§4.5): below it on agreement a judge stays reported. */
export const AGREEMENT_BAR = 0.8;
/** Fewer labels than this say nothing about a judge, whatever share of them agree. */
export const MIN_LABELS_PER_JUDGE = 5;
export const QUEUE_SIZE = 20;

/** Where an output came from; a holdout or owner-named case never reaches the queue. */
export interface CaseRef {
  case: string;
  videoType: string;
  split: string;
  ownerNamed: boolean;
}

/** One judge verdict the owner can label: "yes" to `question` means the judge should have passed it. */
export interface JudgedOutput extends CaseRef {
  judge: CalibrationJudge;
  target: string;
  question: string;
  excerpt: string;
  pass: boolean;
}

/** What the owner sees: no judge, no verdict. */
export interface QueueItem {
  id: string;
  case: string;
  question: string;
  excerpt: string;
}

export const KeyEntrySchema = z
  .object({
    id: z.string().min(1),
    judge: z.enum(CALIBRATION_JUDGES),
    case: z.string().min(1),
    videoType: z.string().min(1),
    target: z.string().min(1),
    pass: z.boolean(),
  })
  .strict();
export type KeyEntry = z.infer<typeof KeyEntrySchema>;

export const QueueKeySchema = z.object({ schema: z.literal("calibration-key/v1"), round: z.string().min(1), entries: z.array(KeyEntrySchema).min(1) }).strict();
export type QueueKey = z.infer<typeof QueueKeySchema>;

export interface CalibrationQueue {
  items: QueueItem[];
  key: KeyEntry[];
}

const seeded = (seed: string, output: JudgedOutput): string =>
  createHash("sha256").update(`${seed}\0${output.case}\0${output.judge}\0${output.target}`).digest("hex");

const shuffled = (outputs: readonly JudgedOutput[], seed: string): JudgedOutput[] =>
  [...outputs].sort((a, b) => seeded(seed, a).localeCompare(seeded(seed, b)));

function groupBy(outputs: readonly JudgedOutput[], keyOf: (output: JudgedOutput) => string): JudgedOutput[][] {
  const groups = new Map<string, JudgedOutput[]>();
  for (const output of outputs) groups.set(keyOf(output), [...(groups.get(keyOf(output)) ?? []), output]);
  return [...groups.keys()].sort().map((key) => groups.get(key)!);
}

/**
 * Judges take turns, so each gets an even share however many outputs it has; within a judge, its video type and
 * verdict buckets take turns, so its share mixes both.
 */
function perJudge(outputs: readonly JudgedOutput[], seed: string): JudgedOutput[][] {
  return groupBy(outputs, (o) => o.judge).map((mine) => {
    const buckets = groupBy(mine, (o) => `${o.videoType}\0${String(o.pass)}`).map((bucket) => shuffled(bucket, seed));
    return roundRobin(buckets, mine.length);
  });
}

function roundRobin(groups: readonly JudgedOutput[][], size: number): JudgedOutput[] {
  const queues = groups.map((group) => [...group]);
  const picked: JudgedOutput[] = [];
  while (picked.length < size && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next && picked.length < size) picked.push(next);
    }
  }
  return picked;
}

export const eligible = (output: CaseRef): boolean => output.split !== "holdout" && !output.ownerNamed;

/** Grouped by case so the owner reads one video at a time; the seed fixes the order within a case. */
export function buildQueue(outputs: readonly JudgedOutput[], size = QUEUE_SIZE, seed = "tp-4012"): CalibrationQueue {
  const picked = roundRobin(perJudge(outputs.filter(eligible), seed), size);
  const ordered = [...new Set(picked.map((o) => o.case))].sort().flatMap((c) => shuffled(picked.filter((o) => o.case === c), seed));
  const id = (i: number): string => `q${String(i + 1).padStart(2, "0")}`;
  return {
    items: ordered.map((o, i) => ({ id: id(i), case: o.case, question: o.question, excerpt: o.excerpt })),
    key: ordered.map((o, i) => ({ id: id(i), judge: o.judge, case: o.case, videoType: o.videoType, target: o.target, pass: o.pass })),
  };
}
