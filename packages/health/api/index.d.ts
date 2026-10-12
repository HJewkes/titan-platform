import { z } from 'zod';
import { Migration, Db } from '@titan-design/store-sqlite';

/** health/v1 follows draft-inadarei-api-health-check, an open format, so other readers can consume it unchanged. */
declare const HEALTH_STATUSES: readonly ["pass", "warn", "fail"];
declare const healthStatusSchema: z.ZodEnum<{
    pass: "pass";
    warn: "warn";
    fail: "fail";
}>;
type HealthStatus = z.infer<typeof healthStatusSchema>;
declare function worstStatus(statuses: Iterable<HealthStatus>): HealthStatus;
declare const healthCheckSchema: z.ZodObject<{
    componentId: z.ZodOptional<z.ZodString>;
    componentType: z.ZodOptional<z.ZodString>;
    observedValue: z.ZodOptional<z.ZodUnknown>;
    observedUnit: z.ZodOptional<z.ZodString>;
    output: z.ZodOptional<z.ZodString>;
    time: z.ZodOptional<z.ZodString>;
    status: z.ZodEnum<{
        pass: "pass";
        warn: "warn";
        fail: "fail";
    }>;
}, z.core.$loose>;
type HealthCheck = z.infer<typeof healthCheckSchema>;
/** The write schema: what a producer must emit. Its status may not be better than its worst check. */
declare const healthReportSchema: z.ZodObject<{
    started_at: z.ZodOptional<z.ZodString>;
    metrics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    ok: z.ZodOptional<z.ZodBoolean>;
    version: z.ZodOptional<z.ZodString>;
    pid: z.ZodOptional<z.ZodNumber>;
    uptime_ms: z.ZodOptional<z.ZodNumber>;
    port: z.ZodOptional<z.ZodNumber>;
    status: z.ZodEnum<{
        pass: "pass";
        warn: "warn";
        fail: "fail";
    }>;
    checks: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodObject<{
        componentId: z.ZodOptional<z.ZodString>;
        componentType: z.ZodOptional<z.ZodString>;
        observedValue: z.ZodOptional<z.ZodUnknown>;
        observedUnit: z.ZodOptional<z.ZodString>;
        output: z.ZodOptional<z.ZodString>;
        time: z.ZodOptional<z.ZodString>;
        status: z.ZodEnum<{
            pass: "pass";
            warn: "warn";
            fail: "fail";
        }>;
    }, z.core.$loose>>>>;
}, z.core.$loose>;
type HealthReport = z.infer<typeof healthReportSchema>;
/** The read schema. Its output type is what `parseHealthReport` returns, with no cast in between. */
declare const healthReportReadSchema: z.ZodObject<{
    started_at: z.ZodOptional<z.ZodString>;
    metrics: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    ok: z.ZodOptional<z.ZodBoolean>;
    version: z.ZodOptional<z.ZodString>;
    pid: z.ZodOptional<z.ZodNumber>;
    uptime_ms: z.ZodOptional<z.ZodNumber>;
    port: z.ZodOptional<z.ZodNumber>;
    status: z.ZodEnum<{
        pass: "pass";
        warn: "warn";
        fail: "fail";
    }>;
    checks: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodObject<{
        componentId: z.ZodOptional<z.ZodString>;
        componentType: z.ZodOptional<z.ZodString>;
        observedValue: z.ZodOptional<z.ZodUnknown>;
        observedUnit: z.ZodOptional<z.ZodString>;
        output: z.ZodOptional<z.ZodString>;
        time: z.ZodOptional<z.ZodString>;
        status: z.ZodPreprocess<z.ZodEnum<{
            pass: "pass";
            warn: "warn";
            fail: "fail";
        }>, unknown>;
    }, z.core.$loose>>>>;
}, z.core.$loose>;
type HealthReportReading = z.output<typeof healthReportReadSchema>;
/** `ignored` names, by dotted path, the fields the reader dropped because their type was wrong. */
type HealthReportRead = {
    ok: true;
    report: HealthReportReading;
    ignored: string[];
} | {
    ok: false;
    error: string;
};
/**
 * The read side: takes any payload a health route answered with. Only a status (or a legacy
 * boolean `ok`) is required. Unknown fields are kept, a mistyped known field at any depth is
 * dropped and named in `ignored`, and the status never reads better than a check.
 */
declare function parseHealthReport(payload: unknown): HealthReportRead;

/** `unknown` is a probe that could not decide, such as an error inside the probe itself; it is never up. */
declare const SAMPLE_STATUSES: readonly ["pass", "warn", "fail", "unknown"];
declare const sampleStatusSchema: z.ZodEnum<{
    pass: "pass";
    warn: "warn";
    fail: "fail";
    unknown: "unknown";
}>;
type SampleStatus = z.infer<typeof sampleStatusSchema>;
/** One stored probe result. Strict, because it is the write schema of an append-only store. */
declare const healthSampleSchema: z.ZodObject<{
    ts: z.ZodISODateTime;
    target: z.ZodString;
    kind: z.ZodString;
    status: z.ZodEnum<{
        pass: "pass";
        warn: "warn";
        fail: "fail";
        unknown: "unknown";
    }>;
    latencyMs: z.ZodOptional<z.ZodNumber>;
    observed: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    output: z.ZodOptional<z.ZodString>;
    source: z.ZodDefault<z.ZodString>;
    dedupKey: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
type HealthSample = z.infer<typeof healthSampleSchema>;
type HealthSampleInput = z.input<typeof healthSampleSchema>;

/**
 * Append-only by owner decision: every probe result is kept, with no sampling and no pruning.
 * The triggers make that hold for any writer of the file, not only this module.
 */
declare const HEALTH_MIGRATIONS: Migration[];
interface HealthStoreOptions {
    /** A reader such as `titan health uptime` opens read-only and never migrates. */
    readonly?: boolean;
}
/** Opens (creating and migrating unless read-only) a health store; `:memory:` works for tests. */
declare function openHealthStore(dbPath: string, options?: HealthStoreOptions): Db;
/**
 * Validates every row first, then writes them all in one transaction, so a tick costs one commit
 * and a bad row stores nothing. Returns how many rows were written; a known dedup key is skipped.
 */
declare function appendSamples(db: Db, samples: readonly HealthSampleInput[]): number;
/** The target's samples with `from <= ts < to`, oldest first. */
declare function readSamples(db: Db, target: string, from: Date, to: Date): HealthSample[];
interface HealthStoreStats {
    rows: number;
    /** Main database pages only; the WAL file is transient and checkpointed back into them. */
    bytes: number;
    oldestTs: string | null;
    newestTs: string | null;
}
/** Growth is unbounded by design, so the store reports its own size for `titan health cost`. */
declare function storeStats(db: Db): HealthStoreStats;

declare const DEFAULT_TICK_SECONDS = 60;
interface UptimeWindow {
    from: Date;
    to: Date;
    /** Slot width; slots are aligned to the epoch so they match a wall-clock minutely timer. */
    tickSeconds?: number;
}
interface UptimeGap {
    from: string;
    to: string;
}
interface UptimeReport {
    slots: number;
    /** pass or warn: the target answered. */
    up: number;
    down: number;
    /** The probe could not decide; neither up nor down. */
    unknown: number;
    /** No sample at all; never counted as up. */
    missing: number;
    /** `up / slots`, or null for a window with no whole slot. */
    upShareOfWindow: number | null;
    /** `up / (up + down)`, or null when nothing was observed up or down. */
    upShareOfObserved: number | null;
    /** Runs of consecutive missing slots, oldest first. */
    gaps: UptimeGap[];
}
/** The most slots one report may span: a year of 1-second slots, so a bad window fails fast instead of looping. */
declare const MAX_UPTIME_SLOTS: number;
/** Pure fold of one target's samples over `[from, to)`; up, down, unknown and missing are kept apart. */
declare function foldUptime(samples: readonly HealthSample[], window: UptimeWindow): UptimeReport;
/** Uptime of `target` over `[from, to)`, read from the store and folded by `foldUptime`. */
declare function uptime(db: Db, target: string, from: Date, to: Date, options?: {
    tickSeconds?: number;
}): UptimeReport;

interface ProbeHttpTarget {
    name: string;
    url: string;
    timeoutMs: number;
    /** The port the payload must report; a stranger bound to the port must not read as up. */
    expectPort?: number;
    /** Dot paths into the payload (such as `build.sha`) copied into `observed`; a missing path is left out. */
    observe?: string[];
}
interface ProbeHttpDeps {
    fetch?: (url: string, init?: {
        signal?: AbortSignal;
        redirect?: RequestRedirect;
    }) => Promise<Response>;
    /** Epoch milliseconds. */
    now?: () => number;
    /** Runs `fire` once `ms` have passed and returns a cancel. */
    after?: (ms: number, fire: () => void) => () => void;
    /** The pid the target must report, or null when its pid file is missing; identity is skipped when unset. */
    expectedPid?: () => Promise<number | null>;
}
/**
 * GETs a health route once and returns one sample. A target that is down, slow or answering as
 * someone else is a `fail` sample, not an error; a probe that cannot decide is `unknown`.
 */
declare function probeHttp(target: ProbeHttpTarget, deps?: ProbeHttpDeps): Promise<HealthSample>;

export { DEFAULT_TICK_SECONDS, HEALTH_MIGRATIONS, HEALTH_STATUSES, type HealthCheck, type HealthReport, type HealthReportRead, type HealthReportReading, type HealthSample, type HealthSampleInput, type HealthStatus, type HealthStoreOptions, type HealthStoreStats, MAX_UPTIME_SLOTS, type ProbeHttpDeps, type ProbeHttpTarget, SAMPLE_STATUSES, type SampleStatus, type UptimeGap, type UptimeReport, type UptimeWindow, appendSamples, foldUptime, healthCheckSchema, healthReportSchema, healthSampleSchema, healthStatusSchema, openHealthStore, parseHealthReport, probeHttp, readSamples, sampleStatusSchema, storeStats, uptime, worstStatus };
