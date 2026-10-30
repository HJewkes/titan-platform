import { alarmKey, depositItemId, type OwnerItem, type OwnerItemDeposit } from "@titan-design/owner-queue";
import { readAnswer, readSpool } from "@titan-design/owner-queue/spool";
import { readWithdrawal } from "@titan-design/owner-queue/withdraw";

/** TP-4353's cap, the same one `inbox.deposit` holds a seat to: it merges or withdraws an ask before it files a sixth. */
export const MAX_OPEN_PER_ASKER = 5;
const BLOCKER_KEY = "blocker";

export interface BlockerRaise {
  asker: string;
  slug: string;
  blocks: string;
  summary: string;
  since: Date;
  context?: string;
  kind?: "decide" | "approve" | "do";
  command?: string;
  keys?: readonly string[];
  initiative?: string;
  expiresAt?: string;
}

/** The key `clear` withdraws by, so one asker's slug names one blocker however often it is raised. */
export const blockerKey = (asker: string, slug: string): string => alarmKey(`blocker:${asker}:${slug}`);

export const blockerItemId = (asker: string, slug: string): string => depositItemId(asker, `blocker-${slug}`);

/** No default expiry: a blocker that lapses without anyone acting on it defeats the banner. */
export function blockerDeposit(raise: BlockerRaise): OwnerItemDeposit {
  return {
    depositId: `blocker-${raise.slug}`,
    asker: raise.asker,
    kind: raise.kind ?? "do",
    door: "two-way",
    summary: raise.summary,
    context: raise.context ?? `Blocked since ${raise.since.toISOString()}: ${raise.blocks}.`,
    ...(raise.command !== undefined && { command: raise.command }),
    ...(raise.initiative !== undefined && { initiative: raise.initiative }),
    ...(raise.expiresAt !== undefined && { expiresAt: raise.expiresAt }),
    keys: [BLOCKER_KEY, blockerKey(raise.asker, raise.slug), ...(raise.keys ?? [])],
    blocker: { since: raise.since.toISOString(), blocks: raise.blocks },
  };
}

/** A deposit whose answer or marker cannot be read counts as closed, as `withdrawMatching` treats it. */
async function isOpen(dir: string, id: string): Promise<boolean> {
  try {
    return (await readAnswer(dir, id)) === undefined && (await readWithdrawal(dir, id)) === undefined;
  } catch {
    return false;
  }
}

/** Every unanswered, unwithdrawn deposit in the spool. */
export async function openDeposits(dir: string): Promise<OwnerItem[]> {
  const open: OwnerItem[] = [];
  for (const item of (await readSpool(dir)).items) if (await isOpen(dir, item.id)) open.push(item);
  return open;
}

const sinceMs = (item: OwnerItem): number => Date.parse(item.blocker!.since);

/** Open, unexpired blockers, oldest `since` first. */
export function openBlockers(open: readonly OwnerItem[], now: Date): OwnerItem[] {
  const live = (item: OwnerItem): boolean => item.expiresAt === undefined || Date.parse(item.expiresAt) > now.getTime();
  return open.filter((item) => item.blocker !== undefined && live(item)).sort((a, b) => sinceMs(a) - sinceMs(b));
}
