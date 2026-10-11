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

export { type BackoffLevel, type CappedHoursLike, type ClassEntry, type ClassTable, DEFAULT_HALF_LIFE_DAYS, DEFAULT_MIN_N, type LevelStats, type Quantiles, type SizeBand, type TaskClassFacts, type ThroughputConfig, type ThroughputRow, type Watermark, classFor, classTable, sizeBand };
