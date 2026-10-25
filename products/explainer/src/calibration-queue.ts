import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The model judges the owner's labels calibrate: the cold probe, the cold-viewer rubric (J8 to J12) and L1, plus the
 * audition's two pickers, its code total and its cold rubric, which each prefer one storyboard of a pair. The
 * listener is the screen itself: its labels are TP-4080's threshold examples, not a judge TP-4012 promotes.
 */
export const CALIBRATION_JUDGES = ["cold", "cold-rubric", "l1", "audition-code", "audition-rubric", "listener"] as const;
export type CalibrationJudge = (typeof CALIBRATION_JUDGES)[number];

/** The design's bar (§4.5): below it on agreement a judge stays reported. */
export const AGREEMENT_BAR = 0.8;
/** Fewer labels than this say nothing about a judge, whatever share of them agree. */
export const MIN_LABELS_PER_JUDGE = 5;
export const QUEUE_SIZE = 20;
/** Chapters asked "clear on one hearing?" on top of the queue, so no judge loses a label to them. */
export const LISTENER_ITEMS = 3;

/** Where an output came from; a holdout or owner-named case never reaches the queue. */
export interface CaseRef {
  case: string;
  videoType: string;
  split: string;
  ownerNamed: boolean;
}

/**
 * A verdict asks yes or no about one output; a pair asks which of storyboards A and B the owner would rather watch;
 * a listener item asks whether a chapter is clear enough to follow on one hearing.
 */
export type ItemKind = "verdict" | "pair" | "listener";

/**
 * One judge verdict the owner can label: "yes" to `question` means the judge should have passed it, and for a pair,
 * that it prefers A. Outputs sharing a `group` are one owner question, so one label scores every judge in it.
 */
export interface JudgedOutput extends CaseRef {
  judge: CalibrationJudge;
  kind: ItemKind;
  group?: string;
  target: string;
  question: string;
  excerpt: string;
  pass: boolean;
  /** The judge config and run the verdict came from, so an agreement names what it calibrated. */
  configId: string;
  run: string;
  /** The judge's eval_version, so agreement pools only labels of one version of the judge. */
  evalVersion: string;
  /** A listener item's chapter density (questions a sentence), which its label is a threshold example for. */
  density?: number;
}

/** What the owner sees: no judge, no verdict. */
export interface QueueItem {
  id: string;
  case: string;
  kind: ItemKind;
  question: string;
  excerpt: string;
}

const KeyEntrySchema = z
  .object({
    id: z.string().min(1),
    judge: z.enum(CALIBRATION_JUDGES),
    case: z.string().min(1),
    videoType: z.string().min(1),
    target: z.string().min(1),
    pass: z.boolean(),
    configId: z.string(),
    run: z.string(),
    /** Absent from round-1 keys, which predate it. */
    evalVersion: z.string().optional(),
    density: z.number().nonnegative().optional(),
  })
  .strict();
export type KeyEntry = z.infer<typeof KeyEntrySchema>;

export const QueueKeySchema = z.object({ schema: z.literal("calibration-key/v1"), round: z.string().min(1), entries: z.array(KeyEntrySchema).min(1) }).strict();
export type QueueKey = z.infer<typeof QueueKeySchema>;

export interface CalibrationQueue {
  items: QueueItem[];
  key: KeyEntry[];
}

/** The outputs one owner question carries: one, or a pair's judges; the first one stands for the question. */
type Unit = readonly JudgedOutput[];

const seeded = (seed: string, unit: Unit): string =>
  createHash("sha256").update(`${seed}\0${unit[0]!.case}\0${unit[0]!.judge}\0${unit[0]!.target}`).digest("hex");

const shuffled = (units: readonly Unit[], seed: string): Unit[] =>
  [...units].sort((a, b) => seeded(seed, a).localeCompare(seeded(seed, b)));

function groupBy(units: readonly Unit[], keyOf: (unit: Unit) => string): Unit[][] {
  const groups = new Map<string, Unit[]>();
  for (const unit of units) groups.set(keyOf(unit), [...(groups.get(keyOf(unit)) ?? []), unit]);
  return [...groups.keys()].sort().map((key) => groups.get(key)!);
}

function units(outputs: readonly JudgedOutput[]): Unit[] {
  const grouped = new Map<string, JudgedOutput[]>();
  outputs.forEach((o, i) => {
    const key = o.group === undefined ? `\0${i}` : `${o.case}\0${o.group}`;
    grouped.set(key, [...(grouped.get(key) ?? []), o]);
  });
  return [...grouped.values()];
}

/**
 * Judges take turns, so each gets an even share however many outputs it has; within a judge, its video type and
 * verdict buckets take turns, so its share mixes both. A pair's bucket is every verdict it carries, so pairs where
 * the code and rubric pickers disagree get their own turn.
 */
function perJudge(all: readonly Unit[], seed: string): Unit[][] {
  return groupBy(all, (u) => u[0]!.judge).map((mine) => {
    const buckets = groupBy(mine, (u) => `${u[0]!.videoType}\0${u.map((o) => String(o.pass)).join(",")}`).map((bucket) => shuffled(bucket, seed));
    return roundRobin(buckets, mine.length);
  });
}

function roundRobin(groups: readonly Unit[][], size: number): Unit[] {
  const queues = groups.map((group) => [...group]);
  const picked: Unit[] = [];
  while (picked.length < size && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next && picked.length < size) picked.push(next);
    }
  }
  return picked;
}

const eligible = (output: CaseRef): boolean => output.split !== "holdout" && !output.ownerNamed;

const keyEntry = (id: string, o: JudgedOutput): KeyEntry => ({
  id, judge: o.judge, case: o.case, videoType: o.videoType, target: o.target, pass: o.pass, configId: o.configId, run: o.run, evalVersion: o.evalVersion,
  ...(o.density === undefined ? {} : { density: o.density }),
});

const nearest = (maxDensity: number) => (a: JudgedOutput, b: JudgedOutput) =>
  Math.abs(a.density! - maxDensity) - Math.abs(b.density! - maxDensity) || a.case.localeCompare(b.case) || a.target.localeCompare(b.target);

/**
 * The chapters whose labels best place the listener threshold: the nearest to the screen's bar, taking turns between
 * chapters that clear it and chapters that do not, so the owner's answers bracket it.
 */
export function pickListenerItems(candidates: readonly JudgedOutput[], maxDensity: number, count = LISTENER_ITEMS): JudgedOutput[] {
  const side = (clear: boolean) => candidates.filter((o) => eligible(o) && o.pass === clear).sort(nearest(maxDensity)).map((o) => [o]);
  return roundRobin([side(true), side(false)], count).flat();
}

const caseOf = (u: Unit) => u[0]!.case;

/**
 * Clearest first, so an owner who stops early has labelled the most readable material: the clearest video, then the
 * pairs, which are short and score two judges each, then the other videos from clearest to least clear.
 */
function caseOrder(picked: readonly Unit[], clarity: ReadonlyMap<string, number>): string[] {
  const cases = [...new Set(picked.map(caseOf))].sort();
  const isPair = (c: string) => picked.some((u) => caseOf(u) === c && u[0]!.kind === "pair");
  const rank = (c: string) => clarity.get(c) ?? Number.POSITIVE_INFINITY;
  const [first, ...rest] = cases.filter((c) => !isPair(c)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [...(first === undefined ? [] : [first]), ...cases.filter(isPair), ...rest];
}

/** A case's listener items come first, clearest chapter first, while the chapter is still a first hearing; the seed orders the rest. */
function withinCase(mine: readonly Unit[], seed: string): Unit[] {
  const isListener = (u: Unit) => u[0]!.kind === "listener";
  const heard = mine.filter(isListener).sort((a, b) => a[0]!.density! - b[0]!.density!);
  return [...heard, ...shuffled(mine.filter((u) => !isListener(u)), seed)];
}

/**
 * Grouped by case so the owner reads one video at a time. `clarity` ranks cases, lower being easier to follow; an
 * unranked case goes after every ranked one. `listener` items, picked by `pickListenerItems`, join on top of `size`.
 */
export function buildQueue(
  outputs: readonly JudgedOutput[], size = QUEUE_SIZE, seed = "tp-4012", clarity: ReadonlyMap<string, number> = new Map(), listener: readonly JudgedOutput[] = [],
): CalibrationQueue {
  const picked = [...roundRobin(perJudge(units(outputs.filter(eligible)), seed), size), ...listener.filter(eligible).map((o) => [o])];
  const ordered = caseOrder(picked, clarity).flatMap((c) => withinCase(picked.filter((u) => caseOf(u) === c), seed));
  const id = (i: number): string => `q${String(i + 1).padStart(2, "0")}`;
  return {
    items: ordered.map((u, i) => ({ id: id(i), case: caseOf(u), kind: u[0]!.kind, question: u[0]!.question, excerpt: u[0]!.excerpt })),
    key: ordered.flatMap((u, i) => u.map((o) => keyEntry(id(i), o))),
  };
}
