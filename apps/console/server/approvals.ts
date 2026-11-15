/**
 * `approvals.flow`: the owner's one merged queue, read only. Three legs (the factory's needs.list,
 * the console's deposit spool and its rounds dir) go through owner-queue `consolidate`. Each leg
 * catches its own failure into a gap line, so a dead source never reads as an empty queue. A withdrawn
 * round's questions and withdrawn deposits skip consolidation and join the Flow's `withdrawn` list beside superseded items.
 */
import { z } from "zod";
import { consolidate, type Flow, type OwnerItem, type WithdrawnItem } from "@titan-design/owner-queue";
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
  withdrawn?: WithdrawnItem[];
  gaps: string[];
  /** fyi items a leg's source counted instead of sending. */
  fyiCount?: number;
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
  const { items, gaps, fyiCount } = await factory.list();
  const kept = items.filter((item) => item.sources[0]?.system !== "deposit");
  return {
    open: kept.filter((item) => item.status === "open"),
    answered: kept.filter((item) => ANSWERED.has(item.status) && item.answer !== undefined),
    gaps,
    fyiCount,
  };
}

function withoutForeignIdentity(item: OwnerItem): OwnerItem {
  return { ...item, keys: item.keys.filter((key) => !FOREIGN_IDENTITY.test(key)) };
}

async function spoolLeg(inbox: InboxSource): Promise<Leg> {
  const { open, answered, withdrawn, gaps } = await spoolQueueItems(inbox.dir);
  return { open: open.map(withoutForeignIdentity), answered: answered.map(withoutForeignIdentity), withdrawn, gaps };
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

const countedFyi = (legs: readonly Leg[]): number => legs.reduce((sum, leg) => sum + (leg.fyiCount ?? 0), 0);

/** The live head of each PR Shepherd watches, keyed `<owner>/<repo>#<n>`; a row with no PR or head pins nothing. */
export function liveHeads(rows: readonly { repo: string; pr: number | null; headSha: string | null }[]): Record<string, string> {
  const heads: Record<string, string> = {};
  for (const row of rows) if (row.pr !== null && row.headSha !== null) heads[`${row.repo}#${row.pr}`] = row.headSha;
  return heads;
}

/** A failed heads read supersedes nothing, so the flow reads as it did before heads were given. */
async function settledHeads(heads: LiveHeads): Promise<Record<string, string>> {
  try {
    return await heads;
  } catch {
    return {};
  }
}

type LiveHeads = Record<string, string> | Promise<Record<string, string>>;

/** `heads` may still be in flight: the legs read beside it, so the Shepherd read is never serialised behind them. */
export async function readFlow({ factory, rounds, inbox }: ApprovalsSources, heads: LiveHeads = {}): Promise<ApprovalsFlow> {
  const [legs, live] = await Promise.all([
    Promise.all([guarded("factory", () => factoryLeg(factory)), guarded("spool", () => spoolLeg(inbox)), guarded("rounds", () => roundsLeg(rounds))]),
    settledHeads(heads),
  ]);
  const open = legs.flatMap((leg) => leg.open);
  const asks = open.filter((item) => item.lens !== "fyi");
  const consolidated = consolidate(asks, { answered: legs.flatMap((leg) => leg.answered), heads: live });
  const flow = { ...consolidated, withdrawn: [...consolidated.withdrawn, ...legs.flatMap((leg) => leg.withdrawn ?? [])] };
  return { flow: stripHiddenPicks(flow), gaps: legs.flatMap((leg) => leg.gaps), fyiCount: open.length - asks.length + countedFyi(legs), readAt: new Date().toISOString() };
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
