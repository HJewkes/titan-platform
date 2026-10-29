import { kitMigration, nowIso, openDatabase, runMigrations, type Db, type Migration } from "@titan-design/store-sqlite";
import { parseTimingArtifact, type TimingFile, type TimingRun } from "./artifact.js";

const RUNS_DDL = `
        CREATE TABLE runs (
          id           TEXT PRIMARY KEY,
          runner       TEXT NOT NULL,
          runner_class TEXT NOT NULL,
          host         TEXT NOT NULL,
          repo         TEXT,
          commit_sha   TEXT,
          merge_sha    TEXT,
          base_sha     TEXT,
          branch       TEXT,
          pr           INTEGER,
          event        TEXT NOT NULL,
          scope        TEXT NOT NULL,
          scope_filters TEXT NOT NULL,
          shard        TEXT,
          cpus         INTEGER NOT NULL,
          max_workers  INTEGER,
          node         TEXT NOT NULL,
          vitest       TEXT,
          started_at   TEXT NOT NULL,
          started_ms   INTEGER NOT NULL,
          wall_ms      REAL NOT NULL,
          exit         TEXT,
          load_start   REAL,
          load_mean    REAL,
          load_max     REAL,
          raw_path     TEXT,
          raw_sha256   TEXT,
          ingested_at  TEXT NOT NULL
        );
        CREATE INDEX runs_commit ON runs (commit_sha);
        CREATE INDEX runs_host ON runs (host, started_ms);`;

const FILES_DDL = `
        CREATE TABLE files (
          run_id         TEXT NOT NULL REFERENCES runs (id),
          file           TEXT NOT NULL,
          project        TEXT NOT NULL,
          runner_class   TEXT NOT NULL,
          state          TEXT NOT NULL,
          environment_ms REAL NOT NULL,
          prepare_ms     REAL NOT NULL,
          collect_ms     REAL NOT NULL,
          setup_ms       REAL NOT NULL,
          test_ms        REAL NOT NULL,
          total_ms       REAL NOT NULL,
          tests          INTEGER NOT NULL,
          PRIMARY KEY (run_id, project, file)
        );
        CREATE INDEX files_by_file ON files (file, project, runner_class);`;

/**
 * One row per run and one per file in it. File rows are compact and kept indefinitely (D5); only the raw artifacts
 * age out, which is why each run records where its raw file went and its checksum.
 */
export const TIMING_MIGRATIONS: Migration[] = [
  kitMigration(1, { watermark: true }, "ingest watermark"),
  { version: 2, name: "test-timing runs and files", up: (db) => db.exec(RUNS_DDL + FILES_DDL) },
];

const SCHEMA_VERSION = Math.max(...TIMING_MIGRATIONS.map((m) => m.version));

export interface TimingStoreOptions {
  /** A report opens read-only and never migrates. */
  readonly?: boolean;
}

/** Opens (creating and migrating unless read-only) a timing corpus; `:memory:` works for tests. */
export function openTimingStore(dbPath: string, options: TimingStoreOptions = {}): Db {
  const db = openDatabase(dbPath, { readonly: options.readonly, schemaVersion: SCHEMA_VERSION });
  if (!options.readonly) runMigrations(db, TIMING_MIGRATIONS);
  return db;
}

/**
 * Baselines compare like with like: a 4-vCPU GitHub runner never against a 48-core host. Host is a separate column,
 * so two dev machines with the same core count can still be told apart (D6).
 */
export function runnerClass(run: Pick<TimingRun, "runner" | "cpus">): string {
  return `${run.runner}-${run.cpus}c`;
}

export interface RawRef {
  /** Where the archived raw artifact lives, so the corpus can be rebuilt from it. */
  path: string;
  sha256: string;
}

export interface IngestResult {
  runId: string;
  /** False when the run id was already in the store: a re-ingest writes nothing. */
  inserted: boolean;
  files: number;
}

const INSERT_RUN_SQL = `
  INSERT OR IGNORE INTO runs (id, runner, runner_class, host, repo, commit_sha, merge_sha, base_sha, branch, pr, event,
    scope, scope_filters, shard, cpus, max_workers, node, vitest, started_at, started_ms, wall_ms, exit,
    load_start, load_mean, load_max, raw_path, raw_sha256, ingested_at)
  VALUES (@id, @runner, @runner_class, @host, @repo, @commit_sha, @merge_sha, @base_sha, @branch, @pr, @event,
    @scope, @scope_filters, @shard, @cpus, @max_workers, @node, @vitest, @started_at, @started_ms, @wall_ms, @exit,
    @load_start, @load_mean, @load_max, @raw_path, @raw_sha256, @ingested_at)`;

const INSERT_FILE_SQL = `
  INSERT INTO files (run_id, file, project, runner_class, state, environment_ms, prepare_ms, collect_ms, setup_ms,
    test_ms, total_ms, tests)
  VALUES (@run_id, @file, @project, @runner_class, @state, @environment_ms, @prepare_ms, @collect_ms, @setup_ms,
    @test_ms, @total_ms, @tests)`;

function provenanceColumns(run: TimingRun, raw: RawRef | undefined) {
  return {
    load_start: run.load?.start ?? null,
    load_mean: run.load?.mean ?? null,
    load_max: run.load?.max ?? null,
    raw_path: raw?.path ?? null,
    raw_sha256: raw?.sha256 ?? null,
    ingested_at: nowIso(),
  };
}

function runRow(run: TimingRun, raw: RawRef | undefined) {
  return {
    ...provenanceColumns(run, raw),
    id: run.id,
    runner: run.runner,
    runner_class: runnerClass(run),
    host: run.host,
    repo: run.repo,
    commit_sha: run.commit,
    merge_sha: run.mergeSha,
    base_sha: run.baseSha,
    branch: run.branch,
    pr: run.pr,
    event: run.event,
    scope: run.scope.mode,
    scope_filters: JSON.stringify(run.scope.filters),
    shard: run.shard,
    cpus: run.cpus,
    max_workers: run.maxWorkers,
    node: run.node,
    vitest: run.vitest,
    started_at: run.startedAt,
    started_ms: Date.parse(run.startedAt),
    wall_ms: run.wallMs,
    exit: run.exit,
  };
}

function fileRow(runId: string, runnerClassName: string, file: TimingFile) {
  return {
    run_id: runId,
    file: file.file,
    project: file.project,
    runner_class: runnerClassName,
    state: file.state,
    environment_ms: file.environmentMs,
    prepare_ms: file.prepareMs,
    collect_ms: file.collectMs,
    setup_ms: file.setupMs,
    test_ms: file.testMs,
    total_ms: file.totalMs,
    tests: file.tests,
  };
}

/**
 * Parses, then writes the run and its files in one transaction, so a bad artifact stores nothing. Idempotent on
 * `run.id`: ingesting a run the store already holds is a no-op, which makes a resumed or repeated ingest safe.
 */
export function ingestArtifact(db: Db, input: unknown, raw?: RawRef): IngestResult {
  const { run, files } = parseTimingArtifact(input);
  const insertRun = db.prepare(INSERT_RUN_SQL);
  const insertFile = db.prepare(INSERT_FILE_SQL);
  const write = db.transaction((): IngestResult => {
    const row = runRow(run, raw);
    if (insertRun.run(row).changes === 0) return { runId: run.id, inserted: false, files: 0 };
    for (const file of files) insertFile.run(fileRow(run.id, row.runner_class, file));
    return { runId: run.id, inserted: true, files: files.length };
  });
  return write();
}

export interface TimingStoreStats {
  runs: number;
  files: number;
  /** Main database pages only; the WAL file is transient and checkpointed back into them. */
  bytes: number;
  oldestStartedAt: string | null;
  newestStartedAt: string | null;
}

/** File rows are never pruned, so the store reports its own size. */
export function storeStats(db: Db): TimingStoreStats {
  const runs = db.prepare("SELECT COUNT(*) AS n, MIN(started_ms) AS oldest, MAX(started_ms) AS newest FROM runs").get() as {
    n: number;
    oldest: number | null;
    newest: number | null;
  };
  const files = db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number };
  const pageCount = db.pragma("page_count", { simple: true }) as number;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  const iso = (msValue: number | null) => (msValue === null ? null : new Date(msValue).toISOString());
  return { runs: runs.n, files: files.n, bytes: pageCount * pageSize, oldestStartedAt: iso(runs.oldest), newestStartedAt: iso(runs.newest) };
}
