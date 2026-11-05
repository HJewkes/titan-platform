import type { BoardLoop, LoopStatus, LoopTier } from "../../server/loop-board.js";

export type TierKey = "unsorted" | NonNullable<LoopTier>;

export interface TierRow {
  key: TierKey;
  label: string;
  /** What the tier asks of a coordinator; every tier is advisory. */
  hint: string;
}

/** The Unsorted tray first, as in the mock, so a loop the owner has not placed is the first thing seen. */
export const TIER_ROWS: readonly TierRow[] = [
  { key: "unsorted", label: "Unsorted", hint: "owner to place" },
  { key: "S", label: "S", hint: "focus now" },
  { key: "A", label: "A", hint: "next" },
  { key: "B", label: "B", hint: "when free" },
  { key: "C", label: "C", hint: "background" },
  { key: "parked", label: "Parked", hint: "done or on hold" },
];

export const tierKeyOf = (tier: LoopTier): TierKey => (tier === null ? "unsorted" : tier);

/** A loop with no rank sorts after every ranked one, then by title, so a tier's order never depends on the read's. */
function byRank(a: BoardLoop, b: BoardLoop): number {
  return (a.tierRank ?? Number.POSITIVE_INFINITY) - (b.tierRank ?? Number.POSITIVE_INFINITY) || a.title.localeCompare(b.title);
}

/** Each tier's loops in rank order, every tier present even when empty. */
export function groupByTier(loops: readonly BoardLoop[]): Record<TierKey, BoardLoop[]> {
  const inTier = (key: TierKey): BoardLoop[] => loops.filter((loop) => tierKeyOf(loop.tier) === key).sort(byRank);
  return { unsorted: inTier("unsorted"), S: inTier("S"), A: inTier("A"), B: inTier("B"), C: inTier("C"), parked: inTier("parked") };
}

export interface Move {
  id: string;
  to: TierKey;
  /** The loop the moved one lands ahead of; absent, it goes to the end of the tier. */
  before?: string;
}

/** The board as it reads once `move` lands, so the page can show it before the server answers. */
export function applyMove(loops: readonly BoardLoop[], move: Move): BoardLoop[] {
  const tier = move.to === "unsorted" ? null : move.to;
  const peers = loops.filter((loop) => loop.id !== move.id && tierKeyOf(loop.tier) === move.to);
  const ahead = peers.find((loop) => loop.id === move.before);
  const last = Math.max(0, ...peers.map((loop) => loop.tierRank ?? 0));
  const tierRank = tier === null ? null : ahead?.tierRank != null ? ahead.tierRank - 0.5 : last + 1;
  return loops.map((loop) => (loop.id === move.id ? { ...loop, tier, tierRank } : loop));
}

export interface LoopFilters {
  initiative: string | null;
  status: LoopStatus | null;
}

export function filterLoops(loops: readonly BoardLoop[], { initiative, status }: LoopFilters): BoardLoop[] {
  return loops.filter((loop) => (initiative === null || loop.initiative === initiative) && (status === null || loop.status === status));
}

/** A week without motion on a loop that is not done reads as stale, as in the mock. */
const STALE_DAYS = 7;

export const isStale = (loop: BoardLoop): boolean => loop.status !== "DONE" && (loop.daysSinceMotion ?? 0) >= STALE_DAYS;
