import { Interval } from '@titan-design/evidence/stats';

/** One scored test row: the realised value and the interval predicted for it. */
interface IntervalForecast {
    actual: number;
    p10: number;
    p50: number;
    p90: number;
}
interface Coverage$1 {
    hits: number;
    n: number;
    /** Wilson interval on the hit rate; null when there is nothing to score. */
    rate: Interval | null;
}
/** Share of rows whose actual lies inside [p10, p90], with a Wilson interval. */
declare function intervalCoverage(rows: readonly IntervalForecast[], options?: {
    confidence?: number;
}): Coverage$1;
interface ContextLineRow {
    predictedOver: boolean;
    peakContextTokens: number;
}
interface ContextLineScore$1 {
    n: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    /** null when nothing was predicted over the line. */
    precision: number | null;
    /** null when nothing was actually over the line. */
    recall: number | null;
}
/** Precision and recall of the over-150k prediction; null when no row carries a peak. */
declare function contextLineScore(rows: readonly ContextLineRow[]): ContextLineScore$1 | null;

/** Agent-hours under the extractor's headline idle cap. */
interface CappedHoursLike {
    capped: number;
}
/**
 * One done task's actuals. Structural on purpose: a `taskActuals` row from
 * `@titan-design/session-analytics`, spread with the task's `kind` and `estimate`, fits as is.
 */
interface ThroughputRow {
    taskId: string;
    initiative: string;
    /** An ISO datetime or a bare date. */
    doneAt: string;
    implAgentHours: CappedHoursLike;
    reviewAgentHours: CappedHoursLike;
    usd: number;
    kind?: string | null;
    estimate?: number | null;
    flags?: readonly string[];
    /** When the first implementer session started; `backtest` splits train and test on it. */
    firstImplAt?: string | null;
    /** The implementer's peak context in tokens, when the miner recorded it. */
    peakContextTokens?: number | null;
}
/** The plan-time facts that place a task in a class. */
interface TaskClassFacts {
    kind?: string | null;
    estimate?: number | null;
    initiative?: string | null;
}
type SizeBand = "<=1" | "2" | "3" | ">=4" | "none";
declare function sizeBand(estimate: number | null | undefined): SizeBand;

interface Quantiles {
    p10: number;
    p50: number;
    p80: number;
    p90: number;
}

declare const DEFAULT_HALF_LIFE_DAYS = 21;
declare const DEFAULT_MIN_N = 20;
type BackoffLevel = "class" | "kind" | "band" | "initiative" | "global";
interface LevelStats {
    /** Rows at this level. */
    n: number;
    /** Rows at this level after recency weighting; the back-off threshold applies to this. */
    weightedN: number;
    implAgentHours: Quantiles;
    reviewAgentHours: Quantiles;
    usd: Quantiles;
}
/** The quantiles a class gets, and the back-off level and key they came from. */
interface ClassEntry extends LevelStats {
    kind: string;
    band: SizeBand;
    level: BackoffLevel;
    levelKey: string;
}
interface ThroughputConfig {
    /** The time recency weights count back from. Defaults to the newest `doneAt`. */
    asOf?: string;
    /** The session miner's `lastIndexedAt`, recorded in the watermark. */
    minerIndexedAt?: string;
    halfLifeDays?: number;
    minN?: number;
}
interface Watermark {
    newestDoneAt: string;
    minerIndexedAt: string | null;
}
interface ClassTable {
    modelHash: string;
    packageVersion: string;
    watermark: Watermark;
    asOf: string;
    halfLifeDays: number;
    minN: number;
    /** Rows left out because they carry no implementer session. */
    excludedRows: number;
    /** Every observed kind x size band, already backed off without an initiative. */
    classes: Record<string, ClassEntry>;
    levels: {
        class: Record<string, LevelStats>;
        kind: Record<string, LevelStats>;
        band: Record<string, LevelStats>;
        initiative: Record<string, LevelStats>;
        global: LevelStats;
    };
}
/** The quantiles for one task's class, backing off kind, size band, initiative, then global. */
declare function classFor(table: ClassTable, facts: TaskClassFacts): ClassEntry;
/**
 * Per-class weighted quantiles of implementer hours, reviewer hours and USD, keyed kind x size
 * band. Pure: equal rows and config give equal output, whatever the row order.
 */
declare function classTable(actuals: readonly ThroughputRow[], config?: ThroughputConfig): ClassTable;

type BacktestMetric = "implAgentHours" | "reviewAgentHours" | "usd";
/** A task first dispatched but not yet done: right-censored, so counted rather than scored. */
interface OpenTask extends TaskClassFacts {
    taskId: string;
    initiative: string;
    firstImplAt?: string | null;
}
interface BacktestOptions {
    /** ISO dates; each one refits on what was known before it. */
    origins: readonly string[];
    horizonDays?: number;
    metric?: BacktestMetric;
    open?: readonly OpenTask[];
    /** Passed to classTable at each origin; `asOf` is always the origin. */
    config?: Omit<ThroughputConfig, "asOf">;
}
type Coverage = ReturnType<typeof intervalCoverage>;
type ContextLineScore = NonNullable<ReturnType<typeof contextLineScore>>;
interface IntervalScore {
    n: number;
    coverage: Coverage;
    pinball: {
        p10: number | null;
        p50: number | null;
        p90: number | null;
    };
    medianAbsLogError: number | null;
}
/** A point forecast has no interval, so only the p50 loss and the log error apply. */
interface PointScore {
    n: number;
    pinballP50: number | null;
    medianAbsLogError: number | null;
}
interface GroupScore {
    n: number;
    model: IntervalScore;
    /** Coverage after widening each interval by its class's factor from the previous origin. */
    widenedCoverage: Coverage;
    globalMedian: IntervalScore;
    pointsTimesRate: PointScore;
    unweightedClass: IntervalScore;
    /** Estimate vs actual over rows that carry an estimate. */
    spearman: number | null;
}
interface ClassScore extends GroupScore {
    /** The widening factor applied here, fitted on the previous origin's rows of this class. */
    conformalFactor: number;
    /** Open tasks of this class first dispatched in the horizon. */
    open: number;
}
interface Censoring {
    open: number;
    /** open / (open + scored); null when the horizon saw no dispatch. */
    share: number | null;
    byClass: Record<string, number>;
}
interface OriginBase {
    origin: string;
    horizonEnd: string;
    trainN: number;
    testN: number;
    censored: Censoring;
}
interface SkippedOrigin extends OriginBase {
    status: "skipped";
    reason: "no-training-rows";
}
interface ScoredOrigin extends OriginBase {
    status: "scored";
    modelHash: string;
    overall: GroupScore;
    /** Rows with none of the weak-link, multi-task or reopened flags. */
    clean: {
        n: number;
        coverage: Coverage;
        widenedCoverage: Coverage;
    };
    classes: Record<string, ClassScore>;
    contextLine: ContextLineScore | null;
}
type OriginResult = ScoredOrigin | SkippedOrigin;
interface BacktestResult {
    metric: BacktestMetric;
    horizonDays: number;
    /** Eligible rows with no `firstImplAt`, left out of every split. */
    missingFirstImplAt: number;
    /** Rows flagged `no-impl-session`. */
    excludedRows: number;
    origins: OriginResult[];
    /** Coverage over every scored row of every origin. */
    pooled: {
        coverage: Coverage;
        widenedCoverage: Coverage;
        classes: Record<string, {
            coverage: Coverage;
            widenedCoverage: Coverage;
        }>;
    };
}
/**
 * Rolling-origin back-test of classTable. At each origin it fits on rows done and first
 * dispatched before the origin, then scores rows first dispatched in the next horizon against
 * the fit and three baselines. Pure: equal input gives equal output, whatever the row order.
 */
declare function backtest(actuals: readonly ThroughputRow[], options: BacktestOptions): BacktestResult;

declare const DEFAULT_WEEK_MIN_TASKS = 8;
interface ClosureStats {
    n: number;
    weightedN: number;
    /** Recency-weighted share of rows closed with no implementer session. */
    rate: number;
}
interface ClosureRates {
    asOf: string;
    halfLifeDays: number;
    minN: number;
    levels: {
        class: Record<string, ClosureStats>;
        kind: Record<string, ClosureStats>;
        band: Record<string, ClosureStats>;
        initiative: Record<string, ClosureStats>;
        global: ClosureStats;
    };
}
interface ClosureLookup {
    rate: number;
    level: BackoffLevel;
    levelKey: string;
}
interface WeekEffect {
    /** UTC ISO weeks, as the date of their Monday, ascending. */
    weeks: string[];
    /** Per metric, one multiplier per week, normalised to mean 1. */
    multipliers: Record<BacktestMetric, number[]>;
}
interface WeekEffectOptions {
    /** Weeks with fewer rows are dropped. Defaults to 8. */
    minTasks?: number;
}
/**
 * Per-level recency-weighted rate of zero-agent closures (rows flagged `no-impl-session`),
 * weighted with the table's `asOf` and half-life so it matches the table's classes.
 */
declare function closureRates(actuals: readonly ThroughputRow[], table: ClassTable): ClosureRates;
/** One task's closure rate, backing off class, kind, size band, initiative, then global. */
declare function closureFor(rates: ClosureRates, facts: TaskClassFacts): ClosureLookup;
/**
 * Per-week actual / class-p50 ratios over eligible rows, normalised to mean 1 per metric, so a
 * shared week multiplier widens a set forecast without shifting it.
 */
declare function weekEffects(actuals: readonly ThroughputRow[], table: ClassTable, options?: WeekEffectOptions): WeekEffect;

declare const DEFAULT_FORECAST_DRAWS = 2000;
interface SetTask extends TaskClassFacts {
    taskId: string;
}
interface ForecastSetOptions {
    seed: string | number;
    /** Simulated sets. Defaults to 2000. */
    draws?: number;
    /** From `closureRates`; without it no task closes and every `closureRate` is null. */
    closure?: ClosureRates;
    /** From `weekEffects`; one week's multipliers apply to every task in a draw. */
    weekEffect?: WeekEffect;
}
interface TaskForecast {
    taskId: string;
    kind: string;
    band: SizeBand;
    level: BackoffLevel;
    levelKey: string;
    n: number;
    closureRate: number | null;
    closureLevel: BackoffLevel | null;
}
interface UnclassifiableTask {
    taskId: string;
    reason: "unknown-kind";
}
interface SetForecast {
    modelHash: string;
    forecastHash: string;
    seed: string | number;
    draws: number;
    weekEffect: "on" | "off" | "none-available";
    totals: Record<BacktestMetric, Quantiles>;
    tasks: TaskForecast[];
    unclassifiable: UnclassifiableTask[];
}
/**
 * p10/p50/p80/p90 of a task set's total implementer hours, reviewer hours and USD, simulated
 * from each task's class quantiles. Equal tasks, table and options give identical output in any
 * task order.
 */
declare function forecastSet(tasks: readonly SetTask[], table: ClassTable, options: ForecastSetOptions): SetForecast;

declare const DEFAULT_BACKTEST_SET_DRAWS = 1000;
type SetGroupKind = "seat-week" | "parent" | "milestone";
/** Which sets a task belongs to. The caller resolves them; `seat` is the dispatch agent-name prefix. */
interface SetMembership {
    seat?: string | null;
    parents?: readonly string[];
    milestones?: readonly string[];
}
/** A task dispatched but not done. A group holding one is counted as censored, never scored. */
interface OpenSetTask {
    taskId: string;
    /** Lets an open task join its seat-week group; without it, only parent and milestone groups. */
    firstImplAt?: string | null;
}
interface BacktestSetsOptions {
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
interface SetArmScore {
    implAgentHours: Coverage;
    reviewAgentHours: Coverage;
    usd: Coverage;
    pinballImpl: {
        p10: number | null;
        p50: number | null;
        p90: number | null;
    };
}
interface SetKindScore {
    /** Scored groups. */
    n: number;
    /** Groups placed at a scored origin but holding an open task. */
    censored: number;
    independent: SetArmScore;
    weekEffect: SetArmScore;
}
interface ScoredSetGroup {
    kind: SetGroupKind;
    key: string;
    origin: string;
    size: number;
    /** Members' summed actuals, closures counted as 0. */
    actual: Record<BacktestMetric, number>;
    independent: Record<BacktestMetric, Quantiles>;
    weekEffect: Record<BacktestMetric, Quantiles>;
}
interface SetOrigin {
    origin: string;
    trainN: number;
    scored: number;
    censored: number;
    status: "scored" | "skipped";
}
interface BacktestSetsResult {
    horizonDays: number;
    kinds: Record<SetGroupKind, SetKindScore>;
    origins: SetOrigin[];
    groups: ScoredSetGroup[];
}
/**
 * Rolling-origin back-test of forecastSet. At each origin it refits the class table, closure
 * rates and week effects on rows done and started before it, then forecasts every seat-week,
 * parent and milestone group whose first member starts in the next horizon, with and without
 * the week effect, and scores [p10, p90] coverage of the groups' actual totals.
 */
declare function backtestSets(actuals: readonly ThroughputRow[], options: BacktestSetsOptions): BacktestSetsResult;

export { type BackoffLevel, type BacktestMetric, type BacktestOptions, type BacktestResult, type BacktestSetsOptions, type BacktestSetsResult, type CappedHoursLike, type Censoring, type ClassEntry, type ClassScore, type ClassTable, type ClosureLookup, type ClosureRates, type ClosureStats, type ContextLineScore, type Coverage, DEFAULT_BACKTEST_SET_DRAWS, DEFAULT_FORECAST_DRAWS, DEFAULT_HALF_LIFE_DAYS, DEFAULT_MIN_N, DEFAULT_WEEK_MIN_TASKS, type ForecastSetOptions, type GroupScore, type IntervalScore, type LevelStats, type OpenSetTask, type OpenTask, type OriginResult, type PointScore, type Quantiles, type ScoredOrigin, type ScoredSetGroup, type SetArmScore, type SetForecast, type SetGroupKind, type SetKindScore, type SetMembership, type SetOrigin, type SetTask, type SizeBand, type SkippedOrigin, type TaskClassFacts, type TaskForecast, type ThroughputConfig, type ThroughputRow, type UnclassifiableTask, type Watermark, type WeekEffect, type WeekEffectOptions, backtest, backtestSets, classFor, classTable, closureFor, closureRates, forecastSet, sizeBand, weekEffects };
