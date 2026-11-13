import { z } from "zod";
import { isoWeek, round2, share } from "./stats.js";
import type { Labelled, TaskRow } from "./types.js";
import { weekMetrics } from "./week-metrics.js";

/*
 * The "Factory health" group (TP-5446 plan, section 11): Yegge's measurement items, each computed from rows the
 * scorecard already reads. A figure with no source yet is `null` and reads as not measured, never as zero.
 */

/** Who filed a task: the owner, or an agent. */
type Filer = "owner" | "agent";

/** A task file as filed: who filed it (recorded, or the inferred source label), and when it closed. */
export interface FiledTask {
  createdAt: string;
  doneAt: string | null;
  /** Null when the task records neither `source` nor `filed_by` and no inferred label names its source. */
  filer: Labelled<Filer> | null;
}

/** The recorded `source` wins, then the recorded `filed_by`, then the backfill's inferred source label. */
export function filerOf(recorded: { source: string | null; filedBy: string | null }, inferredSource: Labelled<string> | undefined): Labelled<Filer> | null {
  const asFiler = (value: string): Filer => (value === "owner" ? "owner" : "agent");
  if (recorded.source !== null) return { value: asFiler(recorded.source), origin: "recorded" };
  if (recorded.filedBy !== null) return { value: asFiler(recorded.filedBy), origin: "recorded" };
  return inferredSource === undefined ? null : { value: asFiler(inferredSource.value), origin: inferredSource.origin };
}

/** Turns of one seat on one UTC day with one wake cause, as the session graph's `turn.wake_cause` records it. */
export interface WakeCount {
  seat: string;
  day: string;
  cause: string;
  turns: number;
}

/** A `/loop` or ScheduleWakeup wake: the timer. */
const TIMER_CAUSES: ReadonlySet<string> = new Set(["scheduled_wakeup"]);
/** Something happened: a peer message, a broker notice, a background task reporting in. */
const EVENT_CAUSES: ReadonlySet<string> = new Set(["channel_message", "channel_system", "task_notification"]);
/** Typed into the pane: the owner or a heartbeat tick, which the graph cannot tell apart until S14's sender table. */
const TYPED_CAUSES: ReadonlySet<string> = new Set(["human_typed"]);

export interface FactoryHealthInput {
  /** Every stored task row; the group covers the weeks they were dispatched in. */
  rows: readonly TaskRow[];
  /** The model of each task's first dispatch, keyed `initiative/ID`; null when the spawn recorded none. */
  dispatchModels: ReadonlyMap<string, string | null>;
  filed: readonly FiledTask[];
  /** `merged_at` of every merged PR the graph knows. */
  mergedPrAts: readonly string[];
  /** `ts` of every `agent_spawn_refused` event. */
  spawnRefusalAts: readonly string[];
  /** `created_at` of every Shepherd `hitl_gate`: each one holds a run for a decision. */
  gateHoldAts: readonly string[];
  /** Null when the graph's turns carry no wake cause. */
  wakes: readonly WakeCount[] | null;
}

const count = z.number().int().nonnegative();
const measured = z.number().nullable();

const selfGeneratedSchema = z.object({
  agentFiled: count,
  /** Of `agentFiled`, those resting on an inferred source label. */
  agentFiledInferred: count,
  /** Filed this week with no filer recorded or inferred; left out of `agentFiled`. */
  unlabelled: count,
  closed: count,
  mergedPrs: count,
  perClosed: measured,
  perMergedPr: measured,
});

const fenceStopsSchema = z.object({
  dispatched: count,
  spawnRefusals: count,
  gateHolds: count,
  refusalsPer100: measured,
  holdsPer100: measured,
  /** Guard denials are not logged until F22 (slice S20). */
  guardDenials: z.null(),
});

const modelTierSchema = z.object({ model: z.string(), dispatched: count, merged: count, mergeRate: measured, fixRoundsMean: measured });

const seatWakesSchema = z.object({
  seat: z.string(),
  timer: count,
  event: count,
  typed: count,
  /** Needs S14's turn ledger, which records whether a turn acted. */
  timerNoActionShare: z.null(),
});

/** The items section 11.1 maps to figures the scorecard already has, repeated under the group. */
const coveredSchema = z.object({ upkeepShare: measured, reviewRoundsMedian: measured, merged: count, usd: z.number() });

export const factoryHealthSchema = z.object({
  isoWeek: z.string(),
  covered: coveredSchema,
  selfGenerated: selfGeneratedSchema,
  fenceStops: fenceStopsSchema,
  /** Metric 70: the scorecard classifies tasks by label, not paths by tree, so there is no split to count lines by. */
  codeSize: z.null(),
  modelTiers: z.array(modelTierSchema),
  wakes: z.array(seatWakesSchema).nullable(),
});
export type FactoryHealth = z.infer<typeof factoryHealthSchema>;
type ModelTier = z.infer<typeof modelTierSchema>;
type SeatWakes = z.infer<typeof seatWakesSchema>;

/** The model recorded for a dispatch that names none. */
const UNRECORDED_MODEL = "unrecorded";

const PER = 100;

function inWeek(week: string): (ts: string | null) => boolean {
  return (ts) => ts !== null && isoWeek(ts) === week;
}

function per100(part: number, whole: number): number | null {
  const ratio = share(part, whole);
  return ratio === null ? null : round2(ratio * PER);
}

function ratio(part: number, whole: number): number | null {
  const value = share(part, whole);
  return value === null ? null : round2(value);
}

function selfGenerated(input: FactoryHealthInput, week: string): z.infer<typeof selfGeneratedSchema> {
  const at = inWeek(week);
  const filed = input.filed.filter((t) => at(t.createdAt));
  const agent = filed.filter((t) => t.filer?.value === "agent");
  const closed = input.filed.filter((t) => at(t.doneAt)).length;
  const mergedPrs = input.mergedPrAts.filter(at).length;
  return {
    agentFiled: agent.length,
    agentFiledInferred: agent.filter((t) => t.filer!.origin !== "recorded").length,
    unlabelled: filed.filter((t) => t.filer === null).length,
    closed,
    mergedPrs,
    perClosed: ratio(agent.length, closed),
    perMergedPr: ratio(agent.length, mergedPrs),
  };
}

function fenceStops(input: FactoryHealthInput, week: string, dispatched: number): z.infer<typeof fenceStopsSchema> {
  const at = inWeek(week);
  const spawnRefusals = input.spawnRefusalAts.filter(at).length;
  const gateHolds = input.gateHoldAts.filter(at).length;
  return { dispatched, spawnRefusals, gateHolds, refusalsPer100: per100(spawnRefusals, dispatched), holdsPer100: per100(gateHolds, dispatched), guardDenials: null };
}

function rowKey(row: TaskRow): string {
  return `${row.initiative}/${row.taskId}`;
}

/** Merge rate over every dispatched task of the tier; fix rounds over those with a registered PR, as the week figures count them. */
function modelTiers(rows: readonly TaskRow[], models: ReadonlyMap<string, string | null>): ModelTier[] {
  const tiers = new Map<string, TaskRow[]>();
  for (const row of rows) {
    const model = models.get(rowKey(row)) ?? UNRECORDED_MODEL;
    tiers.set(model, [...(tiers.get(model) ?? []), row]);
  }
  return [...tiers]
    .map(([model, members]) => {
      const merged = members.filter((r) => r.mergedAt !== null).length;
      const withPr = members.filter((r) => r.prs > 0);
      const rounds = withPr.reduce((acc, r) => acc + r.fixRounds, 0);
      return { model, dispatched: members.length, merged, mergeRate: ratio(merged, members.length), fixRoundsMean: ratio(rounds, withPr.length) };
    })
    .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

function wakeKind(cause: string): "timer" | "event" | "typed" | null {
  if (TIMER_CAUSES.has(cause)) return "timer";
  if (EVENT_CAUSES.has(cause)) return "event";
  return TYPED_CAUSES.has(cause) ? "typed" : null;
}

/** Each seat's wakes in the week; causes that are neither (a tool result, a compaction) are left out. */
function seatWakes(wakes: readonly WakeCount[], week: string): SeatWakes[] {
  const seats = new Map<string, SeatWakes>();
  for (const wake of wakes) {
    const kind = wakeKind(wake.cause);
    if (kind === null || isoWeek(`${wake.day}T00:00:00.000Z`) !== week) continue;
    const seat = seats.get(wake.seat) ?? { seat: wake.seat, timer: 0, event: 0, typed: 0, timerNoActionShare: null };
    seat[kind] += wake.turns;
    seats.set(wake.seat, seat);
  }
  return [...seats.values()].sort((a, b) => (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0));
}

/** The group for every week a task was first dispatched in, oldest first; a pure function of its input. */
export function factoryHealthWeeks(input: FactoryHealthInput): FactoryHealth[] {
  const weeks = [...new Set(input.rows.map((r) => isoWeek(r.firstDispatchTs)))].sort();
  return weeks.map((week) => {
    const rows = input.rows.filter((r) => isoWeek(r.firstDispatchTs) === week);
    const metrics = weekMetrics(rows);
    return {
      isoWeek: week,
      covered: { upkeepShare: metrics.upkeepShare, reviewRoundsMedian: metrics.reviewRoundsMedian, merged: metrics.merged, usd: metrics.usd },
      selfGenerated: selfGenerated(input, week),
      fenceStops: fenceStops(input, week, rows.length),
      codeSize: null,
      modelTiers: modelTiers(rows, input.dispatchModels),
      wakes: input.wakes === null ? null : seatWakes(input.wakes, week),
    };
  });
}
