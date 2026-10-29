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

export { type IngestResult, type RawRef, TIMING_MIGRATIONS, TIMING_SCHEMA_ID, type TimingArtifact, type TimingFile, type TimingRun, type TimingStoreOptions, type TimingStoreStats, ingestArtifact, openTimingStore, parseTimingArtifact, runnerClass, storeStats, timingArtifactReadSchema, timingArtifactSchema };
