/**
 * The console's own two legs of the owner queue as OwnerItems: review rounds from the rounds dir and
 * deposits from the inbox spool. Each leg answers `{ open, answered, gaps }`, the rounds leg also
 * `withdrawn`, and never throws, so one bad file costs a gap line, never the queue. Gap lines name a round, file or item, never its contents.
 */
import { answeredFromFeedback, fromRoundQuestions, type OwnerItem, type WithdrawnItem } from "@titan-design/owner-queue";
import { readAnswer, readSpool } from "@titan-design/owner-queue/spool";
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
function openItems(round: QueueRound, items: RoundItems): void {
  try {
    const asked = fromRoundQuestions(round.manifest, round.id, { openedAt: round.updatedAt });
    const { withdrawn } = round;
    if (withdrawn === null) items.open.push(...asked);
    else items.withdrawn.push(...asked.map((item) => withdrawnItem(item, withdrawn)));
  } catch {
    items.gaps.push(`${round.id}: its questions could not be read as queue items`);
  }
}

/** A sent round is closed, so its questions are answered items only; feedback that does not fit leaves it open. */
function roundItems(round: QueueRound, items: RoundItems): void {
  if (round.feedback === null) {
    openItems(round, items);
    return;
  }
  try {
    const context = { roundId: round.id, openedAt: round.updatedAt };
    items.answered.push(...answeredFromFeedback(round.feedback, round.manifest, context));
  } catch {
    items.gaps.push(`${round.id}: feedback.json does not fit its round`);
    openItems(round, items);
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
