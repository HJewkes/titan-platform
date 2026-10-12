import { intervalCoverage, meanPinballLoss } from "./backtest-metrics.js";
import type { BacktestMetric, Coverage } from "./backtest.js";
import { classTable, type ClassTable, type ThroughputConfig } from "./class-table.js";
import { forecastSet, type SetTask } from "./forecast-set.js";
import { isEligible, type ThroughputRow } from "./rows.js";
import { closureRates, isoWeekOf, weekEffects, type ClosureRates, type WeekEffect } from "./set-inputs.js";
import type { Quantiles } from "./weighted-quantiles.js";

const MS_PER_DAY = 86_400_000;
const DEFAULT_HORIZON_DAYS = 7;
export const DEFAULT_BACKTEST_SET_DRAWS = 1000;
const DEFAULT_MIN_SET_SIZE = 2;

export type SetGroupKind = "seat-week" | "parent" | "milestone";

/** Which sets a task belongs to. The caller resolves them; `seat` is the dispatch agent-name prefix. */
export interface SetMembership {
  seat?: string | null;
  parents?: readonly string[];
  milestones?: readonly string[];
}

/** A task dispatched but not done. A group holding one is counted as censored, never scored. */
export interface OpenSetTask {
  taskId: string;
  /** Lets an open task join its seat-week group; without it, only parent and milestone groups. */
  firstImplAt?: string | null;
}

export interface BacktestSetsOptions {
  /** ISO dates; each one refits on rows done and started before it. */
  origins: readonly string[];
  horizonDays?: number;
  /** By taskId. */
  memberships: Readonly<Record<string, SetMembership>>;
  seed: string | number;
  /** Simulated sets per forecast. Defaults to 1000. */
  draws?: number;
  /** Groups with fewer members are dropped. Defaults to 2. */
  minSetSize?: number;
  open?: readonly OpenSetTask[];
  /** Passed to classTable at each origin; `asOf` is always the origin. */
  config?: Omit<ThroughputConfig, "asOf">;
  /** Passed to weekEffects as `minTasks`. */
  weekMinTasks?: number;
}

export interface SetArmScore {
  implAgentHours: Coverage;
  reviewAgentHours: Coverage;
  usd: Coverage;
  pinballImpl: { p10: number | null; p50: number | null; p90: number | null };
}

export interface SetKindScore {
  /** Scored groups. */
  n: number;
  /** Groups placed at a scored origin but holding an open task. */
  censored: number;
  independent: SetArmScore;
  weekEffect: SetArmScore;
}

export interface ScoredSetGroup {
  kind: SetGroupKind;
  key: string;
  origin: string;
  size: number;
  /** Members' summed actuals, closures counted as 0. */
  actual: Record<BacktestMetric, number>;
  independent: Record<BacktestMetric, Quantiles>;
  weekEffect: Record<BacktestMetric, Quantiles>;
}

export interface SetOrigin {
  origin: string;
  trainN: number;
  scored: number;
  censored: number;
  status: "scored" | "skipped";
}

export interface BacktestSetsResult {
  horizonDays: number;
  kinds: Record<SetGroupKind, SetKindScore>;
  origins: SetOrigin[];
  groups: ScoredSetGroup[];
}

interface StartedRow {
  row: ThroughputRow;
  startMs: number;
  doneMs: number;
}

interface Member {
  taskId: string;
  startMs: number | null;
  done: StartedRow | null;
}

interface SetGroup {
  kind: SetGroupKind;
  key: string;
  members: Member[];
  startMs: number;
  censored: boolean;
}

interface OriginFit {
  table: ClassTable;
  closure: ClosureRates;
  week: WeekEffect;
}

interface RunContext {
  seed: string | number;
  draws: number;
  config: BacktestSetsOptions["config"];
  weekMinTasks: number | undefined;
}

function parseMs(value: string, what: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new RangeError(`${what} ${JSON.stringify(value)} is not a date`);
  return ms;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Float sums depend on order, so rows are put in one canonical order before any summing.
function startedRows(actuals: readonly ThroughputRow[]): StartedRow[] {
  const keyed = actuals.map((row) => ({
    key: JSON.stringify([row.taskId, row.initiative, row.doneAt, row.firstImplAt ?? "", row.implAgentHours.capped, row.reviewAgentHours.capped, row.usd, row.kind ?? "", row.estimate ?? -1]),
    row,
  }));
  return keyed
    .sort((a, b) => byText(a.key, b.key))
    .map(({ row }) => ({
      row,
      startMs: parseMs(row.firstImplAt ?? row.doneAt, `task ${row.taskId}: start`),
      doneMs: parseMs(row.doneAt, `task ${row.taskId}: doneAt`),
    }));
}

function members(rows: readonly StartedRow[], open: readonly OpenSetTask[]): Member[] {
  const done = rows.map((row): Member => ({ taskId: row.row.taskId, startMs: row.startMs, done: row }));
  const pending = [...open]
    .sort((a, b) => byText(a.taskId, b.taskId))
    .map((task): Member => ({ taskId: task.taskId, startMs: task.firstImplAt ? parseMs(task.firstImplAt, `open task ${task.taskId}: firstImplAt`) : null, done: null }));
  return [...done, ...pending];
}

function groupKeys(member: Member, membership: SetMembership | undefined): [SetGroupKind, string][] {
  if (!membership) return [];
  const keys: [SetGroupKind, string][] = [];
  if (membership.seat && member.startMs !== null) keys.push(["seat-week", `seat-week:${membership.seat}:${isoWeekOf(member.startMs)}`]);
  for (const parent of new Set(membership.parents ?? [])) keys.push(["parent", `parent:${parent}`]);
  for (const milestone of new Set(membership.milestones ?? [])) keys.push(["milestone", `milestone:${milestone}`]);
  return keys;
}

function toGroup(kind: SetGroupKind, key: string, grouped: Member[]): SetGroup | null {
  const starts = grouped.flatMap((member) => (member.startMs === null ? [] : [member.startMs]));
  if (starts.length === 0) return null;
  return { kind, key, members: grouped, startMs: Math.min(...starts), censored: grouped.some((member) => member.done === null) };
}

function buildGroups(all: readonly Member[], memberships: BacktestSetsOptions["memberships"], minSetSize: number): SetGroup[] {
  const byKey = new Map<string, { kind: SetGroupKind; members: Member[] }>();
  for (const member of all) {
    const membership = Object.hasOwn(memberships, member.taskId) ? memberships[member.taskId] : undefined;
    for (const [kind, key] of groupKeys(member, membership)) {
      const group = byKey.get(key);
      if (group) group.members.push(member);
      else byKey.set(key, { kind, members: [member] });
    }
  }
  return [...byKey.keys()]
    .sort(byText)
    .flatMap((key) => {
      const { kind, members: grouped } = byKey.get(key)!;
      const group = grouped.length >= minSetSize ? toGroup(kind, key, grouped) : null;
      return group ? [group] : [];
    });
}

function fitOrigin(train: readonly ThroughputRow[], origin: string, context: RunContext): OriginFit {
  const table = classTable(train, { ...context.config, asOf: origin });
  return { table, closure: closureRates(train, table), week: weekEffects(train, table, { minTasks: context.weekMinTasks }) };
}

function actualTotals(group: SetGroup): Record<BacktestMetric, number> {
  const totals = { implAgentHours: 0, reviewAgentHours: 0, usd: 0 };
  for (const { done } of group.members) {
    if (!done || !isEligible(done.row)) continue;
    totals.implAgentHours += done.row.implAgentHours.capped;
    totals.reviewAgentHours += done.row.reviewAgentHours.capped;
    totals.usd += done.row.usd;
  }
  return totals;
}

// Seat-week sets are chosen by dispatch, so they hold no zero-agent closures to forecast.
// Seeding by group key means adding a group never moves another group's draws.
function forecastGroup(group: SetGroup, fit: OriginFit, origin: string, context: RunContext): ScoredSetGroup {
  const tasks = group.members.map(({ done }): SetTask => {
    const { taskId, kind, estimate, initiative } = done!.row;
    return { taskId, kind, estimate, initiative };
  });
  const closure = group.kind === "seat-week" ? undefined : fit.closure;
  const options = { seed: `${context.seed}:${origin}:${group.key}`, draws: context.draws, closure };
  return {
    kind: group.kind,
    key: group.key,
    origin,
    size: tasks.length,
    actual: actualTotals(group),
    independent: forecastSet(tasks, fit.table, options).totals,
    weekEffect: forecastSet(tasks, fit.table, { ...options, weekEffect: fit.week }).totals,
  };
}

function runOrigin(rows: readonly StartedRow[], groups: readonly SetGroup[], startMs: number, endMs: number, context: RunContext): { origin: SetOrigin; scored: ScoredSetGroup[]; censored: SetGroup[] } {
  const origin = new Date(startMs).toISOString();
  const train = rows.filter((row) => row.doneMs < startMs && row.startMs < startMs).map((row) => row.row);
  if (!train.some(isEligible)) return { origin: { origin, trainN: train.length, scored: 0, censored: 0, status: "skipped" }, scored: [], censored: [] };
  const placed = groups.filter((group) => group.startMs >= startMs && group.startMs < endMs);
  const censored = placed.filter((group) => group.censored);
  const fit = fitOrigin(train, origin, context);
  const scored = placed.filter((group) => !group.censored).map((group) => forecastGroup(group, fit, origin, context));
  return { origin: { origin, trainN: train.length, scored: scored.length, censored: censored.length, status: "scored" }, scored, censored };
}

function armScore(groups: readonly ScoredSetGroup[], arm: "independent" | "weekEffect"): SetArmScore {
  const coverage = (metric: BacktestMetric): Coverage => intervalCoverage(groups.map((group) => ({ actual: group.actual[metric], ...group[arm][metric] })));
  const pinball = (quantile: "p10" | "p50" | "p90", tau: number): number | null =>
    meanPinballLoss(groups.map((group) => ({ actual: group.actual.implAgentHours, predicted: group[arm].implAgentHours[quantile] })), tau);
  return {
    implAgentHours: coverage("implAgentHours"),
    reviewAgentHours: coverage("reviewAgentHours"),
    usd: coverage("usd"),
    pinballImpl: { p10: pinball("p10", 0.1), p50: pinball("p50", 0.5), p90: pinball("p90", 0.9) },
  };
}

function kindScores(scored: readonly ScoredSetGroup[], censored: readonly SetGroup[]): Record<SetGroupKind, SetKindScore> {
  const score = (kind: SetGroupKind): SetKindScore => {
    const groups = scored.filter((group) => group.kind === kind);
    const censoredN = censored.filter((group) => group.kind === kind).length;
    return { n: groups.length, censored: censoredN, independent: armScore(groups, "independent"), weekEffect: armScore(groups, "weekEffect") };
  };
  return { "seat-week": score("seat-week"), parent: score("parent"), milestone: score("milestone") };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer, got ${value}`);
  return value;
}

function validHorizon(horizonDays: number): number {
  if (!(horizonDays > 0) || !Number.isFinite(horizonDays)) throw new RangeError(`horizonDays must be a positive number, got ${horizonDays}`);
  return horizonDays;
}

/**
 * Rolling-origin back-test of forecastSet. At each origin it refits the class table, closure
 * rates and week effects on rows done and started before it, then forecasts every seat-week,
 * parent and milestone group whose first member starts in the next horizon, with and without
 * the week effect, and scores [p10, p90] coverage of the groups' actual totals.
 */
export function backtestSets(actuals: readonly ThroughputRow[], options: BacktestSetsOptions): BacktestSetsResult {
  const horizonDays = validHorizon(options.horizonDays ?? DEFAULT_HORIZON_DAYS);
  const context: RunContext = { seed: options.seed, draws: positiveInteger(options.draws ?? DEFAULT_BACKTEST_SET_DRAWS, "draws"), config: options.config, weekMinTasks: options.weekMinTasks };
  const rows = startedRows(actuals);
  const groups = buildGroups(members(rows, options.open ?? []), options.memberships, positiveInteger(options.minSetSize ?? DEFAULT_MIN_SET_SIZE, "minSetSize"));
  const origins = [...new Set(options.origins.map((origin) => parseMs(origin, "origin")))].sort((a, b) => a - b);
  const runs = origins.map((startMs) => runOrigin(rows, groups, startMs, startMs + horizonDays * MS_PER_DAY, context));
  const scored = runs.flatMap((run) => run.scored);
  return { horizonDays, kinds: kindScores(scored, runs.flatMap((run) => run.censored)), origins: runs.map((run) => run.origin), groups: scored };
}
