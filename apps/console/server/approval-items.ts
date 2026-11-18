/**
 * The console's own two legs of the owner queue as OwnerItems: review rounds from the rounds dir and
 * deposits from the inbox spool. Each leg answers `{ open, answered, withdrawn, gaps }` and never throws,
 * so one bad file costs a gap line, never the queue. Gap lines name a round, file or item, never its contents.
 */
import { answeredFromFeedback, collapseRepeats, fromRoundQuestions, type OwnerItem, type WithdrawnItem } from "@titan-design/owner-queue";
import { readAnswer, readSpool } from "@titan-design/owner-queue/spool";
import { readWithdrawal } from "@titan-design/owner-queue/withdraw";
import { reviewManifest, type ReviewManifest } from "./round-schema.js";
import type { QueueRound, Withdrawal } from "./rounds.js";

interface QueueItems {
  open: OwnerItem[];
  answered: OwnerItem[];
  withdrawn: WithdrawnItem[];
  gaps: string[];
}

const empty = (): QueueItems => ({ open: [], answered: [], withdrawn: [], gaps: [] });

/** `<owner>/<repo>#<n>` from a merge-bound question's pinned PR key, or empty for any other question. */
function prOf(item: OwnerItem): string {
  const key = item.keys.find((each) => each.startsWith("pr:"));
  return key === undefined ? "" : key.slice("pr:".length, key.lastIndexOf("@"));
}

function withdrawnItem(item: OwnerItem, { reason }: Withdrawal): WithdrawnItem {
  return { item: { ...item, status: "withdrawn" }, was: item.status, pr: prOf(item), reason };
}

/** An unsent round's questions are asked, unless the round was withdrawn: then they are listed as withdrawn only. */
function openItems(round: QueueRound, manifest: ReviewManifest, items: QueueItems): void {
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
 * A sent round is closed, so its questions are answered items only; feedback that does not fit leaves it open.
 * owner-queue parses the manifest strictly, so it gets the review-schema manifest, never the console's own fields.
 */
function roundItems(round: QueueRound, items: QueueItems): void {
  const { feedback } = round;
  const manifest = reviewManifest(round.manifest);
  if (feedback === null) {
    // An open feedback sheet (TP-5458) waits on no decision, so it asks the inbox nothing; its sent notes still record.
    if (round.manifest.kind !== "feedback" || round.withdrawn !== null) openItems(round, manifest, items);
    return;
  }
  try {
    const context = { roundId: round.id, openedAt: round.updatedAt };
    items.answered.push(...answeredFromFeedback(feedback, manifest, context));
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

/** True when the deposit's seat withdrew it; a malformed marker is a gap and leaves the deposit to its answer. */
async function withdrawnDeposit(dir: string, item: OwnerItem, items: QueueItems): Promise<boolean> {
  try {
    const withdrawal = await readWithdrawal(dir, item.id);
    if (withdrawal === undefined) return false;
    const { reason, actor } = withdrawal;
    items.withdrawn.push({ item: { ...item, status: "withdrawn" }, was: "open", pr: "", reason, ...(actor === undefined ? {} : { actor }) });
    return true;
  } catch {
    items.gaps.push(`${item.id}: its withdrawal file is malformed`);
    return false;
  }
}

async function spoolItem(dir: string, item: OwnerItem, items: QueueItems): Promise<void> {
  if (await withdrawnDeposit(dir, item, items)) return;
  try {
    const answer = await readAnswer(dir, item.id);
    if (answer === undefined) items.open.push(item);
    else items.answered.push({ ...item, status: "answered", answer });
  } catch {
    items.gaps.push(`${item.id}: its answer file is malformed`);
    items.open.push(item);
  }
}

/**
 * A deposit with an answer file beside it is answered, one its seat withdrew is withdrawn, and repeats of one
 * alarm collapse into the newest open one. readSpool's reject reasons never quote the file.
 */
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
  return { ...items, open: collapseRepeats(items.open) };
}
