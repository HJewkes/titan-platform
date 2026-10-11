import { seededRandom } from "@titan-design/evidence";
import type { BacktestMetric } from "./backtest.js";
import { classFor, type BackoffLevel, type ClassEntry, type ClassTable } from "./class-table.js";
import { modelHash } from "./model-hash.js";
import { drawFromQuantiles } from "./quantile-draw.js";
import { type SizeBand, type TaskClassFacts } from "./rows.js";
import { closureFor, type ClosureRates, type WeekEffect } from "./set-inputs.js";
import { weightedQuantiles, type Quantiles } from "./weighted-quantiles.js";

export const DEFAULT_FORECAST_DRAWS = 2000;

export interface SetTask extends TaskClassFacts {
  taskId: string;
}

export interface ForecastSetOptions {
  seed: string | number;
  /** Simulated sets. Defaults to 2000. */
  draws?: number;
  /** From `closureRates`; without it no task closes and every `closureRate` is null. */
  closure?: ClosureRates;
  /** From `weekEffects`; one week's multipliers apply to every task in a draw. */
  weekEffect?: WeekEffect;
}

export interface TaskForecast {
  taskId: string;
  kind: string;
  band: SizeBand;
  level: BackoffLevel;
  levelKey: string;
  n: number;
  closureRate: number | null;
  closureLevel: BackoffLevel | null;
}

export interface UnclassifiableTask {
  taskId: string;
  reason: "unknown-kind";
}

export interface SetForecast {
  modelHash: string;
  forecastHash: string;
  seed: string | number;
  draws: number;
  weekEffect: "on" | "off" | "none-available";
  totals: Record<BacktestMetric, Quantiles>;
  tasks: TaskForecast[];
  unclassifiable: UnclassifiableTask[];
}

interface ResolvedTask {
  forecast: TaskForecast;
  entry: ClassEntry;
  closeRate: number;
}

type Totals = Record<BacktestMetric, number>;

function validateDraws(draws: number): number {
  if (!Number.isInteger(draws) || draws <= 0) throw new RangeError(`draws must be a positive integer, got ${draws}`);
  return draws;
}

function validateWeekEffect(weekEffect: WeekEffect | undefined): void {
  if (!weekEffect) return;
  for (const [metric, multipliers] of Object.entries(weekEffect.multipliers)) {
    if (multipliers.length !== weekEffect.weeks.length) throw new RangeError(`weekEffect.multipliers.${metric} has ${multipliers.length} entries for ${weekEffect.weeks.length} weeks`);
  }
}

function resolveTask(task: SetTask, table: ClassTable, closure: ClosureRates | undefined): ResolvedTask {
  const entry = classFor(table, task);
  const closed = closure ? closureFor(closure, task) : null;
  const { kind, band, level, levelKey, n } = entry;
  const forecast = { taskId: task.taskId, kind, band, level, levelKey, n, closureRate: closed?.rate ?? null, closureLevel: closed?.level ?? null };
  return { forecast, entry, closeRate: closed?.rate ?? 0 };
}

// Drawing in taskId order makes the output independent of the order tasks were passed in.
function resolveTasks(tasks: readonly SetTask[], table: ClassTable, closure: ClosureRates | undefined): ResolvedTask[] {
  const sorted = [...tasks].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  sorted.forEach((task, i) => {
    if (i > 0 && sorted[i - 1]!.taskId === task.taskId) throw new RangeError(`task ${task.taskId} appears twice`);
  });
  return sorted.map((task) => resolveTask(task, table, closure));
}

function weekMultipliers(weekEffect: WeekEffect | undefined, random: () => number): Totals {
  if (!weekEffect || weekEffect.weeks.length === 0) return { implAgentHours: 1, reviewAgentHours: 1, usd: 1 };
  const week = Math.floor(random() * weekEffect.weeks.length);
  const { implAgentHours, reviewAgentHours, usd } = weekEffect.multipliers;
  return { implAgentHours: implAgentHours[week]!, reviewAgentHours: reviewAgentHours[week]!, usd: usd[week]! };
}

// One u drives implementer hours and USD together, because USD is mostly implementer tokens.
function drawSet(tasks: readonly ResolvedTask[], weekEffect: WeekEffect | undefined, random: () => number): Totals {
  const multiplier = weekMultipliers(weekEffect, random);
  const totals: Totals = { implAgentHours: 0, reviewAgentHours: 0, usd: 0 };
  for (const { entry, closeRate } of tasks) {
    const closes = random() < closeRate;
    const implU = random();
    const reviewU = random();
    if (closes) continue;
    totals.implAgentHours += drawFromQuantiles(entry.implAgentHours, implU) * multiplier.implAgentHours;
    totals.usd += drawFromQuantiles(entry.usd, implU) * multiplier.usd;
    totals.reviewAgentHours += drawFromQuantiles(entry.reviewAgentHours, reviewU) * multiplier.reviewAgentHours;
  }
  return totals;
}

function summarise(samples: readonly Totals[]): Record<BacktestMetric, Quantiles> {
  const of = (metric: BacktestMetric): Quantiles => weightedQuantiles(samples.map((sample) => ({ value: sample[metric], weight: 1 })));
  return { implAgentHours: of("implAgentHours"), reviewAgentHours: of("reviewAgentHours"), usd: of("usd") };
}

function weekEffectState(weekEffect: WeekEffect | undefined): SetForecast["weekEffect"] {
  if (!weekEffect) return "off";
  return weekEffect.weeks.length > 0 ? "on" : "none-available";
}

/**
 * p10/p50/p80/p90 of a task set's total implementer hours, reviewer hours and USD, simulated
 * from each task's class quantiles. Equal tasks, table and options give identical output in any
 * task order.
 */
export function forecastSet(tasks: readonly SetTask[], table: ClassTable, options: ForecastSetOptions): SetForecast {
  const draws = validateDraws(options.draws ?? DEFAULT_FORECAST_DRAWS);
  validateWeekEffect(options.weekEffect);
  const resolved = resolveTasks(tasks, table, options.closure);
  const random = seededRandom(`forecastSet:${options.seed}`);
  const samples = Array.from({ length: draws }, () => drawSet(resolved, options.weekEffect, random));
  const { seed, closure, weekEffect } = options;
  return {
    modelHash: table.modelHash,
    forecastHash: modelHash({ table: table.modelHash, seed, draws, closure, weekEffect }),
    seed,
    draws,
    weekEffect: weekEffectState(weekEffect),
    totals: summarise(samples),
    tasks: resolved.map(({ forecast }) => forecast),
    unclassifiable: resolved
      .filter(({ forecast }) => !Object.hasOwn(table.levels.kind, forecast.kind))
      .map(({ forecast }) => ({ taskId: forecast.taskId, reason: "unknown-kind" as const })),
  };
}
