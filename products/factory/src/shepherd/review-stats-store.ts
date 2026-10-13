import { openDatabase, runMigrations, type Db, type Migration } from "@titan-design/store-sqlite";
import { z } from "zod";

/** Its own file beside the factory database, which is only ever opened read-only, so its tables need no factory migration. */
export const REVIEW_STATS_DB = "review-stats.sqlite3";

/**
 * Schema v1, documented for dashboards: times are epoch ms, money is list-price USD. `review` holds one row per finished
 * review round; `review_run` holds each shepherd-pr run's registration and merge, so a PR with no round still has a row.
 */
const DDL = `
  CREATE TABLE review (
    run_id       TEXT NOT NULL,
    round        INTEGER NOT NULL,
    repo         TEXT NOT NULL,
    pr           INTEGER,
    head_sha     TEXT,
    reviewer     TEXT,
    session_id   TEXT,
    model        TEXT,
    requested_at INTEGER NOT NULL,
    started_at   INTEGER,
    verdict_at   INTEGER,
    queue_ms     INTEGER,
    review_ms    INTEGER,
    verdict      TEXT,
    input        INTEGER,
    cache_read   INTEGER,
    cache_write  INTEGER,
    output       INTEGER,
    usd          REAL,
    cost_source  TEXT,
    PRIMARY KEY (run_id, round)
  );
  CREATE INDEX review_session ON review(session_id);
  CREATE TABLE review_run (
    run_id        TEXT PRIMARY KEY,
    repo          TEXT NOT NULL,
    pr            INTEGER,
    registered_at INTEGER NOT NULL,
    merged_at     INTEGER
  );
  CREATE TABLE review_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE VIEW pr_review AS
    SELECT run.repo, run.pr,
           COUNT(review.round) AS rounds,
           SUM(review.usd) AS usd,
           SUM(review.review_ms) AS review_ms,
           SUM(review.queue_ms) AS queue_ms,
           MIN(run.registered_at) AS registered_at,
           MAX(run.merged_at) AS merged_at
    FROM review_run AS run LEFT JOIN review ON review.run_id = run.run_id
    WHERE run.pr IS NOT NULL
    GROUP BY run.repo, run.pr;`;

const MIGRATIONS: readonly Migration[] = [{ version: 1, name: "factory:review_stats", up: (db) => db.exec(DDL) }];

export type CostSource = "retire" | "transcript";

export interface ReviewRow {
  runId: string;
  round: number;
  repo: string;
  pr: number | null;
  headSha: string | null;
  reviewer: string | null;
  sessionId: string | null;
  model: string | null;
  requestedAt: number;
  startedAt: number | null;
  verdictAt: number | null;
  queueMs: number | null;
  reviewMs: number | null;
  verdict: string | null;
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number } | null;
  usd: number | null;
  costSource: CostSource | null;
}

export interface ReviewRunRow {
  runId: string;
  repo: string;
  pr: number | null;
  registeredAt: number;
  mergedAt: number | null;
}

export interface Unpriced {
  runId: string;
  round: number;
  sessionId: string;
}

const WATERMARK = "refreshed_through";
const Value = z.object({ value: z.string() });
const UnpricedRow = z.object({ run_id: z.string(), round: z.number(), session_id: z.string() });

const reviewParams = (row: ReviewRow) => ({
  runId: row.runId, round: row.round, repo: row.repo, pr: row.pr, headSha: row.headSha, reviewer: row.reviewer, sessionId: row.sessionId,
  model: row.model, requestedAt: row.requestedAt, startedAt: row.startedAt, verdictAt: row.verdictAt, queueMs: row.queueMs, reviewMs: row.reviewMs,
  verdict: row.verdict, input: row.tokens?.input ?? null, cacheRead: row.tokens?.cacheRead ?? null, cacheWrite: row.tokens?.cacheWrite ?? null,
  output: row.tokens?.output ?? null, usd: row.usd, costSource: row.costSource,
});

/** The derived review store: rows are written once a round is final and keyed so a repeat write replaces rather than adds. */
export class ReviewStatsStore {
  constructor(readonly db: Db) {
    runMigrations(db, MIGRATIONS);
  }

  static open(path: string): ReviewStatsStore {
    return new ReviewStatsStore(openDatabase(path));
  }

  upsertReview(row: ReviewRow): void {
    this.db.prepare(
      `INSERT INTO review (run_id, round, repo, pr, head_sha, reviewer, session_id, model, requested_at, started_at, verdict_at, queue_ms, review_ms,
         verdict, input, cache_read, cache_write, output, usd, cost_source)
       VALUES (@runId, @round, @repo, @pr, @headSha, @reviewer, @sessionId, @model, @requestedAt, @startedAt, @verdictAt, @queueMs, @reviewMs,
         @verdict, @input, @cacheRead, @cacheWrite, @output, @usd, @costSource)
       ON CONFLICT (run_id, round) DO UPDATE SET repo = excluded.repo, pr = excluded.pr, head_sha = excluded.head_sha, reviewer = excluded.reviewer,
         session_id = excluded.session_id, model = excluded.model, requested_at = excluded.requested_at, started_at = excluded.started_at,
         verdict_at = excluded.verdict_at, queue_ms = excluded.queue_ms, review_ms = excluded.review_ms, verdict = excluded.verdict,
         input = excluded.input, cache_read = excluded.cache_read, cache_write = excluded.cache_write, output = excluded.output,
         usd = excluded.usd, cost_source = excluded.cost_source`,
    ).run(reviewParams(row));
  }

  upsertRun(run: ReviewRunRow): void {
    this.db.prepare(
      `INSERT INTO review_run (run_id, repo, pr, registered_at, merged_at) VALUES (@runId, @repo, @pr, @registeredAt, @mergedAt)
       ON CONFLICT (run_id) DO UPDATE SET repo = excluded.repo, pr = excluded.pr, registered_at = excluded.registered_at, merged_at = excluded.merged_at`,
    ).run(run);
  }

  /** The rounds of `runId` already stored, which a refresh never reads or prices again. */
  storedRounds(runId: string): Set<number> {
    return new Set(z.array(z.number()).parse(this.db.prepare("SELECT round FROM review WHERE run_id = ?").pluck().all(runId)));
  }

  /** Stored rounds of `sessionId`; a session that served more than one round cannot take one retire row's whole spend. */
  roundsOfSession(sessionId: string): number {
    return z.number().parse(this.db.prepare("SELECT COUNT(*) FROM review WHERE session_id = ?").pluck().get(sessionId));
  }

  /** Stored rounds with a session and no cost: a retire row written since can still price them without a transcript read. */
  unpriced(): Unpriced[] {
    const rows = z.array(UnpricedRow).parse(this.db.prepare("SELECT run_id, round, session_id FROM review WHERE usd IS NULL AND session_id IS NOT NULL").all());
    return rows.map((row) => ({ runId: row.run_id, round: row.round, sessionId: row.session_id }));
  }

  setCost(key: Pick<Unpriced, "runId" | "round">, cost: Pick<ReviewRow, "tokens" | "usd" | "costSource" | "model">): void {
    this.db.prepare(
      `UPDATE review SET usd = @usd, cost_source = @costSource, model = COALESCE(model, @model), input = @input, cache_read = @cacheRead,
         cache_write = @cacheWrite, output = @output WHERE run_id = @runId AND round = @round AND usd IS NULL`,
    ).run({ ...key, usd: cost.usd, costSource: cost.costSource, model: cost.model, input: cost.tokens?.input ?? null, cacheRead: cost.tokens?.cacheRead ?? null, cacheWrite: cost.tokens?.cacheWrite ?? null, output: cost.tokens?.output ?? null });
  }

  /** The ISO `completed_at` up to which every finished run has been read; undefined before the first refresh. */
  refreshedThrough(): string | undefined {
    const row = this.db.prepare("SELECT value FROM review_meta WHERE key = ?").get(WATERMARK);
    return row === undefined ? undefined : Value.parse(row).value;
  }

  setRefreshedThrough(at: string): void {
    this.db.prepare("INSERT INTO review_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(WATERMARK, at);
  }

  transaction(work: () => void): void {
    this.db.transaction(work)();
  }

  close(): void {
    this.db.close();
  }
}
