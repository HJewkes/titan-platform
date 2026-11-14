import { rulePlacement } from "@titan-design/session-analytics";
import type { OperatorPick, PickCounts } from "./compare-picks.js";
import type { ShadowRowRead } from "./compare-read.js";

/*
 * Shadow versus the operator for one UTC day (TP-5755 PLAN 5.6). Agreement is the scorecard's: the operator's task is
 * in the top K of the latest shadow wake before the spawn, K = distinct operator first-dispatches that day, placed with
 * session-analytics' `rulePlacement` so both measures share one definition.
 */

const DAY_MS = 86_400_000;

const AGREEMENT_DEFINITION =
  "operator spawn's task in the top K of the latest shadow wake before it, K = distinct operator first-dispatches that day (mirrors scorecard rulePlacement)";

interface Wake {
  wake: string;
  at: number;
  rows: ShadowRowRead[];
  unreadable: boolean;
}

interface OperatorOnly {
  task: string;
  spawnedAt: string;
  shadowVerdict: "refused" | "absent" | "would-dispatch";
  codes: string[];
  stage?: string;
  rank?: number;
}

interface ShadowOnly {
  task: string;
  firstPicked: string;
  bet: string | null;
  basis: string | null;
}

interface LaneNumbers {
  lane: string;
  n: number;
  inTopK: number;
  rate: number | null;
  wouldDispatch: number;
}

export interface CompareReport {
  day: string;
  lanes: string[];
  wakes: number;
  unreadableWakes: number;
  badLines: number;
  operator: { seat: string; spawns: number; source: { eventsDb: number; ledger: number }; counts: PickCounts };
  agreement: { inTopK: number; of: number; rate: number | null; k: number; rankPctMedian: number | null; definition: string };
  shadowOnly: ShadowOnly[];
  operatorOnly: OperatorOnly[];
  strictVsRelaxed: { wouldDispatchStrict: number; wouldDispatchRelaxed: number };
  perLane: LaneNumbers[];
}

interface CompareInput {
  day: string;
  lanes: string[];
  seat: string;
  dayRows: ShadowRowRead[];
  priorRows: ShadowRowRead[];
  badLines: number;
  /** Distinct first picks inside the day. */
  picks: OperatorPick[];
  /** Every pick within a day either side, so a shadow pick is matched against spawns up to 24 h away. */
  nearbyPicks: OperatorPick[];
  counts: PickCounts;
}

export const laneKey = (lane: ShadowRowRead["lane"]): string => (lane === undefined ? "unlaned" : `${lane.initiative}/${lane.tag ?? "*"}`);

const isUnreadRow = (row: ShadowRowRead): boolean => (row.task ?? null) === null && (row.codes ?? []).includes("signal-unreadable");

function groupWakes(rows: readonly ShadowRowRead[]): Wake[] {
  const byWake = new Map<string, ShadowRowRead[]>();
  for (const row of rows) byWake.set(row.wake, [...(byWake.get(row.wake) ?? []), row]);
  return [...byWake.entries()]
    .map(([wake, all]) => {
      const judged = all.filter((row) => row.kind !== "wake");
      const at = Date.parse((all.find((row) => row.kind === "wake") ?? all[0]!).at);
      return { wake, at, rows: judged, unreadable: judged.length > 0 && judged.every(isUnreadRow) };
    })
    .sort((a, b) => a.at - b.at);
}

function latestWakeBefore(wakes: readonly Wake[], at: number): Wake | undefined {
  return wakes.filter((wake) => wake.at <= at).at(-1);
}

/** The wake's pick order: would-dispatch before held, then rank, then lane order, as the tick fills slots. */
function wakeRanking(wake: Wake, lanes: readonly string[]): string[] {
  const ranked = wake.rows.filter((row) => typeof row.task === "string" && row.rank !== undefined);
  const order = (row: ShadowRowRead) => [row.kind === "would-dispatch" ? 0 : 1, row.rank!, lanes.indexOf(laneKey(row.lane))];
  ranked.sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
  });
  return [...new Set(ranked.map((row) => row.task!))];
}

function verdictAt(wake: Wake | undefined, pick: OperatorPick): OperatorOnly {
  const spawnedAt = new Date(pick.at).toISOString();
  const row = wake?.rows.find((candidate) => candidate.task === pick.task);
  if (row?.kind === "refused") return { task: pick.task, spawnedAt, shadowVerdict: "refused", codes: row.codes ?? [], ...(row.stage !== undefined && { stage: row.stage }) };
  if (row !== undefined) return { task: pick.task, spawnedAt, shadowVerdict: "would-dispatch", codes: [], ...(row.rank !== undefined && { rank: row.rank }) };
  const codes = wake === undefined ? ["no-prior-wake"] : wake.unreadable ? ["signal-unreadable"] : ["not-in-lane"];
  return { task: pick.task, spawnedAt, shadowVerdict: "absent", codes };
}

interface Placed {
  pick: OperatorPick;
  lane: string;
  inTopK: boolean;
  rankPct: number | null;
  wake: Wake | undefined;
}

function place(picks: readonly OperatorPick[], wakes: readonly Wake[], lanes: readonly string[]): Placed[] {
  const k = picks.length;
  return picks.map((pick) => {
    const wake = latestWakeBefore(wakes, pick.at);
    const ranked = wake === undefined ? [] : wakeRanking(wake, lanes);
    const placement = rulePlacement({ ranked, topK: ranked.slice(0, k) }, pick.task);
    const row = wake?.rows.find((candidate) => candidate.task === pick.task);
    return { pick, lane: row === undefined ? "unlaned" : laneKey(row.lane), inTopK: placement?.inTopK ?? false, rankPct: placement?.rankPct ?? null, wake };
  });
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const rate = (hits: number, of: number): number | null => (of === 0 ? null : Math.round((hits / of) * 100) / 100);

function shadowOnly(dayRows: readonly ShadowRowRead[], nearby: readonly OperatorPick[]): ShadowOnly[] {
  const first = new Map<string, ShadowRowRead>();
  for (const row of dayRows) if (row.kind === "would-dispatch" && typeof row.task === "string" && !first.has(row.task)) first.set(row.task, row);
  return [...first.values()]
    .filter((row) => !nearby.some((pick) => pick.task === row.task && Math.abs(pick.at - Date.parse(row.at)) <= DAY_MS))
    .map((row) => ({ task: row.task!, firstPicked: row.at, bet: row.bet ?? null, basis: row.basis ?? null }));
}

function strictVsRelaxed(dayRows: readonly ShadowRowRead[]): CompareReport["strictVsRelaxed"] {
  const would = dayRows.filter((row) => row.kind === "would-dispatch" && typeof row.task === "string");
  const strict = would.filter((row) => (row.relaxed ?? []).length === 0);
  return { wouldDispatchStrict: new Set(strict.map((row) => row.task)).size, wouldDispatchRelaxed: new Set(would.map((row) => row.task)).size };
}

function perLane(lanes: readonly string[], placed: readonly Placed[], dayRows: readonly ShadowRowRead[]): LaneNumbers[] {
  const seen = [...new Set([...lanes, ...placed.map((entry) => entry.lane)])];
  return seen.map((lane) => {
    const mine = placed.filter((entry) => entry.lane === lane);
    const hits = mine.filter((entry) => entry.inTopK).length;
    const would = dayRows.filter((row) => row.kind === "would-dispatch" && laneKey(row.lane) === lane);
    return { lane, n: mine.length, inTopK: hits, rate: rate(hits, mine.length), wouldDispatch: new Set(would.map((row) => row.task)).size };
  });
}

export function compareDay(input: CompareInput): CompareReport {
  const dayWakes = groupWakes(input.dayRows);
  const placed = place(input.picks, groupWakes([...input.priorRows, ...input.dayRows]), input.lanes);
  const unreadableWakes = dayWakes.filter((wake) => wake.unreadable).length;
  const judged = dayWakes.length > 0 && unreadableWakes < dayWakes.length;
  const hits = placed.filter((entry) => entry.inTopK).length;
  const ledger = input.picks.filter((pick) => pick.source === "ledger").length;
  const rankPctMedian = median(placed.flatMap((entry) => entry.rankPct ?? []));
  return {
    day: input.day,
    lanes: input.lanes,
    wakes: dayWakes.length,
    unreadableWakes,
    badLines: input.badLines,
    operator: { seat: input.seat, spawns: input.picks.length, source: { eventsDb: input.picks.length - ledger, ledger }, counts: input.counts },
    agreement: { inTopK: hits, of: placed.length, rate: judged ? rate(hits, placed.length) : null, k: input.picks.length, rankPctMedian, definition: AGREEMENT_DEFINITION },
    shadowOnly: shadowOnly(input.dayRows, input.nearbyPicks),
    operatorOnly: placed.filter((entry) => !entry.inTopK).map((entry) => verdictAt(entry.wake, entry.pick)),
    strictVsRelaxed: strictVsRelaxed(input.dayRows),
    perLane: perLane(input.lanes, placed, input.dayRows),
  };
}
