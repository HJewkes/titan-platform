import { z } from 'zod';
import { Migration, Db } from '@titan-design/store-sqlite';

declare const TIMING_SCHEMA_ID = "titan.test-timing/v1";
/** Strict: what a reporter must write. An unknown key is an error, so a typo never reaches the corpus. */
declare const timingArtifactSchema: z.ZodObject<{
    schema: z.ZodLiteral<"titan.test-timing/v1">;
    run: z.ZodObject<{
        id: z.ZodString;
        runner: z.ZodString;
        host: z.ZodString;
        repo: z.ZodNullable<z.ZodString>;
        commit: z.ZodNullable<z.ZodString>;
        mergeSha: z.ZodNullable<z.ZodString>;
        baseSha: z.ZodNullable<z.ZodString>;
        branch: z.ZodNullable<z.ZodString>;
        pr: z.ZodNullable<z.ZodNumber>;
        event: z.ZodString;
        scope: z.ZodObject<{
            mode: z.ZodEnum<{
                full: "full";
                scoped: "scoped";
                related: "related";
            }>;
            filters: z.ZodArray<z.ZodString>;
        }, z.core.$strip>;
        shard: z.ZodNullable<z.ZodString>;
        cpus: z.ZodNumber;
        maxWorkers: z.ZodNullable<z.ZodNumber>;
        node: z.ZodString;
        vitest: z.ZodNullable<z.ZodString>;
        startedAt: z.ZodISODateTime;
        load: z.ZodNullable<z.ZodObject<{
            start: z.ZodNumber;
            mean: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$strip>>;
        wallMs: z.ZodNumber;
        exit: z.ZodNullable<z.ZodEnum<{
            passed: "passed";
            failed: "failed";
            interrupted: "interrupted";
        }>>;
    }, z.core.$strip>;
    files: z.ZodArray<z.ZodObject<{
        project: z.ZodString;
        file: z.ZodString;
        state: z.ZodString;
        environmentMs: z.ZodNumber;
        prepareMs: z.ZodNumber;
        collectMs: z.ZodNumber;
        setupMs: z.ZodNumber;
        testMs: z.ZodNumber;
        totalMs: z.ZodNumber;
        tests: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** Loose: what an ingester accepts, keeping keys a newer reporter added. */
declare const timingArtifactReadSchema: z.ZodObject<{
    schema: z.ZodLiteral<"titan.test-timing/v1">;
    run: z.ZodObject<{
        id: z.ZodString;
        runner: z.ZodString;
        host: z.ZodString;
        repo: z.ZodNullable<z.ZodString>;
        commit: z.ZodNullable<z.ZodString>;
        mergeSha: z.ZodNullable<z.ZodString>;
        baseSha: z.ZodNullable<z.ZodString>;
        branch: z.ZodNullable<z.ZodString>;
        pr: z.ZodNullable<z.ZodNumber>;
        event: z.ZodString;
        scope: z.ZodObject<{
            mode: z.ZodEnum<{
                full: "full";
                scoped: "scoped";
                related: "related";
            }>;
            filters: z.ZodArray<z.ZodString>;
        }, z.core.$strip>;
        shard: z.ZodNullable<z.ZodString>;
        cpus: z.ZodNumber;
        maxWorkers: z.ZodNullable<z.ZodNumber>;
        node: z.ZodString;
        vitest: z.ZodNullable<z.ZodString>;
        startedAt: z.ZodISODateTime;
        load: z.ZodNullable<z.ZodObject<{
            start: z.ZodNumber;
            mean: z.ZodNumber;
            max: z.ZodNumber;
        }, z.core.$strip>>;
        wallMs: z.ZodNumber;
        exit: z.ZodNullable<z.ZodEnum<{
            passed: "passed";
            failed: "failed";
            interrupted: "interrupted";
        }>>;
    }, z.core.$strip>;
    files: z.ZodArray<z.ZodObject<{
        project: z.ZodString;
        file: z.ZodString;
        state: z.ZodString;
        environmentMs: z.ZodNumber;
        prepareMs: z.ZodNumber;
        collectMs: z.ZodNumber;
        setupMs: z.ZodNumber;
        testMs: z.ZodNumber;
        totalMs: z.ZodNumber;
        tests: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
type TimingArtifact = z.infer<typeof timingArtifactSchema>;
type TimingRun = TimingArtifact["run"];
type TimingFile = TimingArtifact["files"][number];
/** Reads one `vitest-file-timing.json`; throws a ZodError naming the first bad field. */
declare function parseTimingArtifact(input: unknown): TimingArtifact;

/**
 * One row per run and one per file in it. File rows are compact and kept indefinitely (D5); only the raw artifacts
 * age out, which is why each run records where its raw file went and its checksum.
 */
declare const TIMING_MIGRATIONS: Migration[];
interface TimingStoreOptions {
    /** A report opens read-only and never migrates. */
    readonly?: boolean;
}
/** Opens (creating and migrating unless read-only) a timing corpus; `:memory:` works for tests. */
declare function openTimingStore(dbPath: string, options?: TimingStoreOptions): Db;
/**
 * Baselines compare like with like: a 4-vCPU GitHub runner never against a 48-core host. Host is a separate column,
 * so two dev machines with the same core count can still be told apart (D6).
 */
declare function runnerClass(run: Pick<TimingRun, "runner" | "cpus">): string;
interface RawRef {
    /** Where the archived raw artifact lives, so the corpus can be rebuilt from it. */
    path: string;
    sha256: string;
}
interface IngestResult {
    runId: string;
    /** False when the run id was already in the store: a re-ingest writes nothing. */
    inserted: boolean;
    files: number;
}
/**
 * Parses, then writes the run and its files in one transaction, so a bad artifact stores nothing. Idempotent on
 * `run.id`: ingesting a run the store already holds is a no-op, which makes a resumed or repeated ingest safe.
 */
declare function ingestArtifact(db: Db, input: unknown, raw?: RawRef): IngestResult;
interface TimingStoreStats {
    runs: number;
    files: number;
    /** Main database pages only; the WAL file is transient and checkpointed back into them. */
    bytes: number;
    oldestStartedAt: string | null;
    newestStartedAt: string | null;
}
/** File rows are never pruned, so the store reports its own size. */
declare function storeStats(db: Db): TimingStoreStats;

declare const fileSafeId: (id: string) => string;
/**
 * Writes one record gzipped under `<home>/raw/<runner>/<yyyy-mm>/` and appends its checksum to that month's
 * SHA256SUMS, so the corpus can always be rebuilt from raw alone and a tampered file is detectable.
 */
declare function archiveRaw(home: string, run: Pick<TimingRun, "id" | "runner" | "startedAt">, body: string): RawRef;

/** What `gh run view --json databaseId,attempt,headSha,headBranch,event,createdAt` says about a CI run. */
interface GhRunMeta {
    databaseId: number;
    attempt: number;
    headSha: string;
    headBranch: string | null;
    event: string;
    createdAt: string;
    /** owner/repo, which `gh run view` does not return. */
    repo: string;
}
/** A record from before the run header (TP-4436 S0): `{ files }` alone, with no totals or test counts. */
declare function isLegacyArtifact(input: unknown): boolean;
interface LegacyUpgrade {
    shard: string | null;
    /** The old record never said; the caller knows (a main push runs the full suite, a pull request may not). */
    scope: "full" | "scoped";
}
/**
 * Builds the v1 header a pre-header CI artifact lacks from the run's own metadata, so the hosted runs measured
 * before S1 join the corpus. Fields the old reporter never saw (node, load, wall time) stay empty or zero.
 */
declare function upgradeLegacyArtifact(input: unknown, meta: GhRunMeta, { shard, scope }: LegacyUpgrade): TimingArtifact;

/**
 * Archives then stores one record. A run the store already holds is skipped before anything is written, so a
 * repeated ingest neither duplicates rows nor appends a second checksum line.
 */
declare function ingestRecord(db: Db, home: string, input: unknown): IngestResult;
interface ArtifactName {
    attempt: number;
    shard: string | null;
}
/** `vitest-file-timing-<attempt>` from a pull request's validate job, `...-shard<i>of<n>-<attempt>` from main's shards. */
declare function parseArtifactName(name: string): ArtifactName | null;
/**
 * One downloaded CI artifact. A pre-header record gets its header from the run's metadata; the attempt comes from the
 * artifact's name, because a run's artifacts include those of its earlier attempts.
 */
declare function ingestGhArtifact(db: Db, home: string, name: string, input: unknown, meta: GhRunMeta, legacyScope?: LegacyUpgrade["scope"]): IngestResult;
/** True once a run attempt's artifacts were all downloaded and ingested, so a scheduled ingest skips it. */
declare function ghRunFetched(db: Db, databaseId: number, attempt: number): boolean;
/** Marks a run attempt done, with how many artifacts it had; zero is a real answer (a none-scope run uploads none). */
declare function markGhRunFetched(db: Db, databaseId: number, attempt: number, artifacts: number): void;
interface SpoolOptions {
    spool?: string;
    now?: number;
    /** A record younger than this may still be being written by the reporter, so it waits for the next pass. */
    minAgeMs?: number;
}
interface SpoolResult {
    ingested: number;
    duplicates: number;
    waiting: number;
    rejected: {
        file: string;
        reason: string;
    }[];
}
/**
 * Moves every settled spool record into the raw archive and the store. The spool copy is deleted once it is archived;
 * an unreadable one goes to `rejected/` beside a `.reason` file, so a bad record is kept but never retried.
 */
declare function ingestSpool(db: Db, home: string, options?: SpoolOptions): SpoolResult;

/** One measurement of a series: a file's or a project's or a whole run's total ms in one full-suite run. */
interface Point {
    runId: string;
    commit: string | null;
    startedMs: number;
    ms: number;
}
interface GrowthRule {
    /** The last N points; their minimum is the current level, so one slow run cannot move it. */
    recent: number;
    /** The points before those; their minimum is the baseline. */
    baseline: number;
    /** Fewest baseline points that make a baseline at all. */
    minBaseline: number;
    /** Fractional rise of the current level over the baseline that counts as growth. */
    threshold: number;
    /** Smallest absolute rise in ms that counts, so a 40 ms file going to 60 ms is not news. */
    floorMs: number;
}
declare const GROWTH_RULE: GrowthRule;
interface Growth {
    baselineMs: number;
    currentMs: number;
    deltaMs: number;
    ratio: number;
    /** The first of the recent points: where the rise shows up. */
    since: Point;
}
/** Min-of-last-N against the min of the trailing window before it, whatever the size; null when too short. */
declare function trendOf(points: Point[], rule?: GrowthRule): Growth | null;
/** The trend, only when it rose by at least the threshold and the floor. */
declare function growthOf(points: Point[], rule?: GrowthRule): Growth | null;
interface AnomalyRule {
    /** How many earlier runs the rolling minimum spans. */
    window: number;
    /** Fewest earlier runs that make a rolling minimum. */
    minWindow: number;
    /** Fractional excess over the rolling minimum that is an anomaly. */
    threshold: number;
    /** Consecutive runs that must all be over, so one slow hosted runner is not an alarm. */
    hold: number;
}
declare const ANOMALY_RULE: AnomalyRule;
interface RunVerdict {
    point: Point;
    /** Minimum of the `window` runs before the held span; null until there are `minWindow` of them. */
    rollingMinMs: number | null;
    /** This run's own excess over the rolling minimum. */
    ratio: number | null;
    /** The held span's minimum over the rolling minimum: the number the threshold judges. */
    heldRatio: number | null;
    anomalous: boolean;
}
/** Each run's total against the minimum of the runs before it; anomalous once `hold` runs in a row are all over. */
declare function runVerdicts(points: Point[], rule?: AnomalyRule): RunVerdict[];
interface Shift {
    beforeMs: number;
    afterMs: number;
    deltaMs: number;
    ratio: number;
    afterRuns: number;
}
/** Min after a cut against the min of the last `window` points before it; null when either side is empty. */
declare function shiftAt(points: Point[], cutMs: number, window: number): Shift | null;

type Level = "suite" | "project" | "file";
interface SeriesFilter {
    runnerClass?: string;
    /** Only runs started at or after this; a report bounds its read so the corpus can grow without the read growing. */
    sinceMs?: number;
}
/** One series of full-suite measurements, oldest first: the whole suite, one project or one file, on one runner class. */
interface Series {
    level: Level;
    runnerClass: string;
    project: string | null;
    file: string | null;
    points: Point[];
}
/** Every series at one level, each point one complete full-suite run, oldest first. */
declare function readSeries(db: Db, level: Level, filter?: SeriesFilter): Series[];
/** When the corpus first saw a commit (a full sha or a prefix of one), for "what got slower since <sha>". */
declare function commitStartedMs(db: Db, commit: string): number | null;

interface SeriesId {
    level: Level;
    runnerClass: string;
    project: string | null;
    file: string | null;
}
interface GrowthFinding extends SeriesId {
    growth: Growth;
}
interface ProjectTrend extends SeriesId {
    runs: number;
    trend: Growth | null;
}
interface SuiteRuns {
    runnerClass: string;
    /** The newest runs, oldest first, each against its rolling minimum. */
    verdicts: RunVerdict[];
}
interface TimingReport {
    generatedAt: string;
    stats: TimingStoreStats;
    rules: {
        growth: GrowthRule;
        anomaly: AnomalyRule;
    };
    suites: SuiteRuns[];
    anomalies: (RunVerdict & {
        runnerClass: string;
    })[];
    growth: GrowthFinding[];
    projects: ProjectTrend[];
}
interface ReportOptions extends SeriesFilter {
    growth?: Partial<GrowthRule>;
    anomaly?: Partial<AnomalyRule>;
    /** How many of the newest suite runs the report lists per runner class. */
    recentRuns?: number;
    now?: number;
}
/**
 * Growth (a file, project or the suite whose min-of-last-N rose over its trailing baseline), anomalies (a suite run
 * over its rolling minimum) and every project's trend, over the full-scope runs the filter admits.
 */
declare function timingReport(db: Db, options?: ReportOptions): TimingReport;
interface SlowerOptions extends SeriesFilter {
    /** How many runs before the cut make the "before" minimum. */
    window?: number;
    threshold?: number;
    floorMs?: number;
}
interface SlowerFinding extends SeriesId {
    shift: Shift;
}
/** Every suite, project and file whose minimum after `cutMs` rose over its minimum before it, largest rise first. */
declare function slowerSince(db: Db, cutMs: number, options?: SlowerOptions): SlowerFinding[];

/** The report a seat reads: anomalies first, then growth, the suite runs and every project's trend. */
declare function renderReportMarkdown(report: TimingReport, { top }?: {
    top?: number;
}): string;
/** "What got slower since <label>", largest rise first. */
declare function renderSlowerMarkdown(findings: SlowerFinding[], label: string, { top }?: {
    top?: number;
}): string;

export { ANOMALY_RULE, type AnomalyRule, type ArtifactName, GROWTH_RULE, type GhRunMeta, type Growth, type GrowthFinding, type GrowthRule, type IngestResult, type LegacyUpgrade, type Level, type Point, type ProjectTrend, type RawRef, type ReportOptions, type RunVerdict, type Series, type SeriesFilter, type SeriesId, type Shift, type SlowerFinding, type SlowerOptions, type SpoolOptions, type SpoolResult, type SuiteRuns, TIMING_MIGRATIONS, TIMING_SCHEMA_ID, type TimingArtifact, type TimingFile, type TimingReport, type TimingRun, type TimingStoreOptions, type TimingStoreStats, archiveRaw, commitStartedMs, fileSafeId, ghRunFetched, growthOf, ingestArtifact, ingestGhArtifact, ingestRecord, ingestSpool, isLegacyArtifact, markGhRunFetched, openTimingStore, parseArtifactName, parseTimingArtifact, readSeries, renderReportMarkdown, renderSlowerMarkdown, runVerdicts, runnerClass, shiftAt, slowerSince, storeStats, timingArtifactReadSchema, timingArtifactSchema, timingReport, trendOf, upgradeLegacyArtifact };
