/**
 * The console's own two legs of the owner queue as OwnerItems: review rounds from the rounds dir and
 * deposits from the inbox spool. Each leg answers `{ open, answered, gaps }` and never throws, so one
 * bad file costs a gap line, never the queue. Gap lines name a round, file or item, never its contents.
 */
import { answeredFromFeedback, fromRoundQuestions, type OwnerItem } from "@titan-design/owner-queue";
import { readAnswer, readSpool } from "@titan-design/owner-queue/spool";
import { ManifestSchema, type Manifest as OwnerQueueManifest } from "@titan-design/review-schema";
import type { QueueRound } from "./rounds.js";

interface QueueItems {
  open: OwnerItem[];
  answered: OwnerItem[];
  gaps: string[];
}

const empty = (): QueueItems => ({ open: [], answered: [], gaps: [] });

function openItems(round: QueueRound, manifest: OwnerQueueManifest, items: QueueItems): void {
  try {
    items.open.push(...fromRoundQuestions(manifest, round.id, { openedAt: round.updatedAt }));
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

/** A sent round is closed, so its questions are answered items only; feedback that does not fit leaves it open. */
function roundItems(round: QueueRound, items: QueueItems): void {
  const manifest = ownerQueueManifest(round, items);
  if (manifest === undefined) return;
  if (round.feedback === null) {
    openItems(round, manifest, items);
    return;
  }
  try {
    const context = { roundId: round.id, openedAt: round.updatedAt };
    items.answered.push(...answeredFromFeedback(round.feedback, manifest, context));
  } catch {
    items.gaps.push(`${round.id}: feedback.json does not fit its round`);
    openItems(round, manifest, items);
  }
}

export function roundQueueItems(rounds: readonly QueueRound[]): QueueItems {
  const items = empty();
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
