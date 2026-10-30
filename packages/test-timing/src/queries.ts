import type { Db } from "@titan-design/store-sqlite";
import type { Point } from "./trend.js";

export type Level = "suite" | "project" | "file";

export interface SeriesFilter {
  runnerClass?: string;
  /** Only runs started at or after this; a report bounds its read so the corpus can grow without the read growing. */
  sinceMs?: number;
}

/** One series of full-suite measurements, oldest first: the whole suite, one project or one file, on one runner class. */
export interface Series {
  level: Level;
  runnerClass: string;
  project: string | null;
  file: string | null;
  points: Point[];
}

interface RunRow {
  id: string;
  shard: string | null;
  runner_class: string;
  commit_sha: string | null;
  started_ms: number;
}

interface MeasureRow {
  run_id: string;
  project: string | null;
  file: string | null;
  ms: number;
}

// Only full-scope runs measure the same file set each time; a scoped or related run's totals are not comparable.
const RUNS_SQL = `SELECT id, shard, runner_class, commit_sha, started_ms FROM runs
  WHERE scope = 'full' AND started_ms >= @since AND (@runner_class IS NULL OR runner_class = @runner_class)`;

// A skipped file measures about 0 ms and would drag a minimum to nothing, so only passed files count.
const COLUMNS: Record<Level, string> = { suite: "NULL AS project, NULL AS file", project: "f.project, NULL AS file", file: "f.project, f.file" };
const GROUP_BY: Record<Level, string> = { suite: "f.run_id", project: "f.run_id, f.project", file: "f.run_id, f.project, f.file" };
const measureSql = (level: Level) => `SELECT f.run_id, ${COLUMNS[level]}, SUM(f.total_ms) AS ms FROM files f JOIN runs r ON r.id = f.run_id
  WHERE r.scope = 'full' AND r.started_ms >= @since AND (@runner_class IS NULL OR r.runner_class = @runner_class)
    AND f.state = 'passed'
  GROUP BY ${GROUP_BY[level]}`;

interface RunGroup {
  id: string;
  runnerClass: string;
  commit: string | null;
  startedMs: number;
}

const groupIdOf = (run: RunRow) => (run.shard ? run.id.replace(/:\d+$/, "") : run.id);

/**
 * A sharded CI run is one artifact per shard; together they are one suite run. A group missing a shard is dropped, so
 * a cancelled shard never reads as a fast suite.
 */
function completeGroups(runs: RunRow[]): Map<string, RunGroup> {
  const shards = new Map<string, Set<string>>();
  const groups = new Map<string, RunGroup>();
  for (const run of runs) {
    const id = groupIdOf(run);
    const known = groups.get(id);
    groups.set(id, { id, runnerClass: run.runner_class, commit: run.commit_sha, startedMs: Math.min(known?.startedMs ?? run.started_ms, run.started_ms) });
    shards.set(id, (shards.get(id) ?? new Set()).add(run.shard ?? "1/1"));
  }
  for (const [id, seen] of shards) {
    const count = Number([...seen][0]?.split("/")[1] ?? 1);
    if (seen.size !== count) groups.delete(id);
  }
  return groups;
}

function addPoint(series: Map<string, Series>, level: Level, group: RunGroup, row: MeasureRow): void {
  const key = [group.runnerClass, row.project, row.file].join("\t");
  const entry = series.get(key) ?? { level, runnerClass: group.runnerClass, project: row.project, file: row.file, points: [] };
  const last = entry.points.at(-1);
  if (last?.runId === group.id) last.ms += row.ms;
  else entry.points.push({ runId: group.id, commit: group.commit, startedMs: group.startedMs, ms: row.ms });
  series.set(key, entry);
}

/** Every series at one level, each point one complete full-suite run, oldest first. */
export function readSeries(db: Db, level: Level, filter: SeriesFilter = {}): Series[] {
  const params = { since: filter.sinceMs ?? 0, runner_class: filter.runnerClass ?? null };
  const runs = db.prepare<typeof params, RunRow>(RUNS_SQL).all(params);
  const groups = completeGroups(runs);
  const groupOfRun = new Map(runs.map((run) => [run.id, groups.get(groupIdOf(run))]));
  const measured = db
    .prepare<typeof params, MeasureRow>(measureSql(level))
    .all(params)
    .flatMap((row) => {
      const group = groupOfRun.get(row.run_id);
      return group ? [{ row, group }] : [];
    })
    // Shards of one run sit together, so a project's shard sums land on one point.
    .sort((a, b) => a.group.startedMs - b.group.startedMs || a.group.id.localeCompare(b.group.id));
  const series = new Map<string, Series>();
  for (const { row, group } of measured) addPoint(series, level, group, row);
  return [...series.values()];
}

/** When the corpus first saw a commit (a full sha or a prefix of one), for "what got slower since <sha>". */
export function commitStartedMs(db: Db, commit: string): number | null {
  const row = db.prepare<[string], { ms: number | null }>("SELECT MIN(started_ms) AS ms FROM runs WHERE commit_sha LIKE ? || '%'").get(commit);
  return row?.ms ?? null;
}
