/**
 * `approvals.flow`: the owner's one merged queue, read only. Three legs (the factory's needs.list,
 * the console's deposit spool and its rounds dir) go through owner-queue `consolidate`. Each leg
 * catches its own failure into a gap line, so a dead source never reads as an empty queue.
 */
import { z } from "zod";
import { consolidate, type Flow, type OwnerItem } from "@titan-design/owner-queue";
import { roundQueueItems, spoolQueueItems } from "./approval-items.js";
import type { factoryNeeds } from "./factory.js";
import type { InboxSource } from "./inbox.js";
import { readCommand } from "./owner-guard.js";
import { readQueueRounds, type RoundsSource } from "./rounds.js";

export type FactoryNeeds = ReturnType<typeof factoryNeeds>;

export interface ApprovalsSources {
  /** Absent in tests and configs that build no factory client; the Flow then carries a gap for it. */
  factory?: FactoryNeeds;
  rounds: RoundsSource;
  inbox: InboxSource;
}

export interface ApprovalsFlow {
  flow: Flow;
  gaps: string[];
  /** `lens: fyi` items are counted, never ordered: live, they outnumber the asks fifteen to one. */
  fyiCount: number;
  readAt: string;
}

interface Leg {
  open: OwnerItem[];
  answered: OwnerItem[];
  gaps: string[];
}

const ANSWERED: ReadonlySet<OwnerItem["status"]> = new Set(["answered", "decided"]);
/** hitl's identity keys. A deposit is agent-written, so it may never claim a gate or run and take its place (R3). */
const FOREIGN_IDENTITY = /^(gate|run):/;

async function guarded(prefix: string, read: () => Promise<Leg>): Promise<Leg> {
  try {
    const leg = await read();
    return { ...leg, gaps: leg.gaps.map((gap) => `${prefix}: ${gap}`) };
  } catch (error) {
    return { open: [], answered: [], gaps: [`${prefix}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/** The console reads deposits from its own spool, so the factory's copies are dropped rather than listed twice (R2). */
async function factoryLeg(factory: FactoryNeeds | undefined): Promise<Leg> {
  if (factory === undefined) return { open: [], answered: [], gaps: ["upstream not configured"] };
  const { items, gaps } = await factory.list();
  const kept = items.filter((item) => item.sources[0]?.system !== "deposit");
  return {
    open: kept.filter((item) => item.status === "open"),
    answered: kept.filter((item) => ANSWERED.has(item.status) && item.answer !== undefined),
    gaps,
  };
}

function withoutForeignIdentity(item: OwnerItem): OwnerItem {
  return { ...item, keys: item.keys.filter((key) => !FOREIGN_IDENTITY.test(key)) };
}

async function spoolLeg(inbox: InboxSource): Promise<Leg> {
  const { open, answered, gaps } = await spoolQueueItems(inbox.dir);
  return { open: open.map(withoutForeignIdentity), answered: answered.map(withoutForeignIdentity), gaps };
}

async function roundsLeg(rounds: RoundsSource): Promise<Leg> {
  const read = await readQueueRounds(rounds);
  const items = roundQueueItems(read.rounds);
  return { ...items, gaps: [...read.gaps, ...items.gaps] };
}

/** An unanswered after-answer question must not show its pick, mirroring what `rounds.get` strips. */
function withoutHiddenPick(item: OwnerItem): OwnerItem {
  if (item.recommended?.hidden !== true || item.answer !== undefined) return item;
  const stripped = { ...item };
  delete stripped.recommended;
  return stripped;
}

function stripHiddenPicks(flow: Flow): Flow {
  return {
    ...flow,
    order: flow.order.map(withoutHiddenPick),
    withdrawn: flow.withdrawn.map((each) => ({ ...each, item: withoutHiddenPick(each.item) })),
    dropped: flow.dropped.map((each) => ({ ...each, item: withoutHiddenPick(each.item) })),
  };
}

export async function readFlow({ factory, rounds, inbox }: ApprovalsSources): Promise<ApprovalsFlow> {
  const legs = await Promise.all([
    guarded("factory", () => factoryLeg(factory)),
    guarded("spool", () => spoolLeg(inbox)),
    guarded("rounds", () => roundsLeg(rounds)),
  ]);
  const open = legs.flatMap((leg) => leg.open);
  const asks = open.filter((item) => item.lens !== "fyi");
  const flow = consolidate(asks, { answered: legs.flatMap((leg) => leg.answered) });
  return { flow: stripHiddenPicks(flow), gaps: legs.flatMap((leg) => leg.gaps), fyiCount: open.length - asks.length, readAt: new Date().toISOString() };
}

export function approvalsCommands(sources: ApprovalsSources) {
  return {
    "approvals.flow": readCommand({
      name: "approvals.flow",
      description: "The owner's merged queue: factory needs, console deposits and review rounds consolidated into one Flow, with a gap line per unreadable source",
      args: z.object({}),
      result: z.custom<ApprovalsFlow>(),
      run: () => readFlow(sources),
    }),
  };
}
