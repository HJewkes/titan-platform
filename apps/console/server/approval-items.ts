/**
 * The console's own two legs of the owner queue as OwnerItems: review rounds from the rounds dir and
 * deposits from the inbox spool. Each leg answers `{ open, answered, gaps }`, the rounds leg also
 * `withdrawn`, and never throws, so one bad file costs a gap line, never the queue. Gap lines name a round, file or item, never its contents.
 */
import { answeredFromFeedback, fromRoundQuestions, type OwnerItem, type WithdrawnItem } from "@titan-design/owner-queue";
import { readAnswer, readSpool } from "@titan-design/owner-queue/spool";
import {
  FeedbackSchema as OwnerQueueFeedbackSchema,
  ManifestSchema,
  type Feedback as OwnerQueueFeedback,
  type Manifest as OwnerQueueManifest,
} from "@titan-design/review-schema";
import type { Feedback } from "./round-schema.js";
import type { QueueRound, Withdrawal } from "./rounds.js";

interface QueueItems {
  open: OwnerItem[];
  answered: OwnerItem[];
  gaps: string[];
}

interface RoundItems extends QueueItems {
  withdrawn: WithdrawnItem[];
}

const empty = (): QueueItems => ({ open: [], answered: [], gaps: [] });

/** `<owner>/<repo>#<n>` from a merge-bound question's pinned PR key, or empty for any other question. */
function prOf(item: OwnerItem): string {
  const key = item.keys.find((each) => each.startsWith("pr:"));
  return key === undefined ? "" : key.slice("pr:".length, key.lastIndexOf("@"));
}

function withdrawnItem(item: OwnerItem, { reason }: Withdrawal): WithdrawnItem {
  return { item: { ...item, status: "withdrawn" }, was: item.status, pr: prOf(item), reason };
}

/** An unsent round's questions are asked, unless the round was withdrawn: then they are listed as withdrawn only. */
function openItems(round: QueueRound, manifest: OwnerQueueManifest, items: RoundItems): void {
  try {
    const asked = fromRoundQuestions(manifest, round.id, { openedAt: round.updatedAt });
    const { withdrawn } = round;
    if (withdrawn === null) items.open.push(...asked);
    else items.withdrawn.push(...asked.map((item) => withdrawnItem(item, withdrawn)));
  } catch {
    items.gaps.push(`${round.id}: its questions could not be read as queue items`);
  }
}

/**
 * The console reads rounds with review-schema 0.3 and owner-queue still with 0.1, so a round only 0.3 accepts
 * is a gap until TP-3232 installs 0.3 in both.
 */
function ownerQueueManifest(round: QueueRound, items: QueueItems): OwnerQueueManifest | undefined {
  const result = ManifestSchema.safeParse(round.manifest);
  if (!result.success) items.gaps.push(`${round.id}: needs review-schema 0.3 in owner-queue (TP-3232)`);
  return result.data;
}

/** Keys review-schema 0.3 added to feedback@1 that 0.1 refuses as unknown; `answeredFromFeedback` reads none of them. */
const NEW_ANSWER_KEYS = ["optionNotes", "after", "recommendationSeen"];
const NEW_RECOMMENDATION_KEYS = ["weakPoint", "fallback"];
const NEW_VARIANT_KEYS = ["clip", "audio"];

const without = (value: object, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

function answerFor01({ recommendation, ...answer }: Feedback["answers"][number]): Record<string, unknown> {
  const kept = without(answer, NEW_ANSWER_KEYS);
  return recommendation === undefined ? kept : { ...kept, recommendation: without(recommendation, NEW_RECOMMENDATION_KEYS) };
}

/**
 * 0.3 feedback projected onto the 0.1 shape owner-queue parses. Any other drift fails the 0.1 parse and is a gap,
 * with no items: the round was answered, so its questions must not open again.
 */
function ownerQueueFeedback(round: QueueRound, feedback: Feedback, items: QueueItems): OwnerQueueFeedback | undefined {
  const projected = { ...feedback, answers: feedback.answers.map(answerFor01), variants: feedback.variants.map((each) => without(each, NEW_VARIANT_KEYS)) };
  const result = OwnerQueueFeedbackSchema.safeParse(projected);
  if (!result.success) items.gaps.push(`${round.id}: its feedback needs review-schema 0.3 in owner-queue (TP-3232)`);
  return result.data;
}

/** A sent round is closed, so its questions are answered items only; feedback that does not fit leaves it open. */
function roundItems(round: QueueRound, items: RoundItems): void {
  const manifest = ownerQueueManifest(round, items);
  if (manifest === undefined) return;
  if (round.feedback === null) {
    openItems(round, manifest, items);
    return;
  }
  const feedback = ownerQueueFeedback(round, round.feedback, items);
  if (feedback === undefined) return;
  try {
    const context = { roundId: round.id, openedAt: round.updatedAt };
    items.answered.push(...answeredFromFeedback(feedback, manifest, context));
  } catch {
    items.gaps.push(`${round.id}: feedback.json does not fit its round`);
    openItems(round, manifest, items);
  }
}

export function roundQueueItems(rounds: readonly QueueRound[]): RoundItems {
  const items = { ...empty(), withdrawn: [] };
  for (const round of rounds) roundItems(round, items);
  return items;
}

async function spoolItem(dir: string, item: OwnerItem, items: QueueItems): Promise<void> {
  try {
    const answer = await readAnswer(dir, item.id);
    if (answer === undefined) items.open.push(item);
    else items.answered.push({ ...item, status: "answered", answer });
  } catch {
    items.gaps.push(`${item.id}: its answer file is malformed`);
    items.open.push(item);
  }
}

/** A deposit with an answer file beside it is answered; readSpool's reject reasons never quote the file. */
export async function spoolQueueItems(dir: string): Promise<QueueItems> {
  const items = empty();
  let spool;
  try {
    spool = await readSpool(dir);
  } catch {
    return { ...items, gaps: ["the spool could not be read"] };
  }
  items.gaps.push(...spool.rejects.map((reject) => `${reject.file}: ${reject.reason}`));
  for (const item of spool.items) await spoolItem(dir, item, items);
  return items;
}
