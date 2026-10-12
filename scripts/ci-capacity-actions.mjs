// TP-2450 slice a: the GitHub Actions side of the CI capacity measurement. Lists each repo's runs per UTC day,
// reads every attempt's jobs, and folds them into per repo/day queue and run minutes plus peak concurrency.
// Queue time is job created_at -> started_at: a needs-gated job is created only when its needs finish, so the run's
// own start would hide the wait. All IO goes through one injected object so tests never reach gh or the disk.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// The runs endpoint returns at most 1000 results per query, however many pages are read.
export const RUN_LIST_CAP = 1000;
// Kept well above zero so a fetch already in flight elsewhere cannot push the account over the 5000/h REST limit.
export const RATE_FLOOR = 200;
export const BATCH = 100;
export const DEFAULT_CACHE = path.join(homedir(), ".cache", "ci-capacity");
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function utcDay(iso) {
  return iso.slice(0, 10);
}

/** Every UTC day from `from` to `to`, both inclusive, as YYYY-MM-DD. */
export function utcDays(from, to) {
  const days = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** The `created=` filters that cover one day: the whole day, or four 6-hour ranges when it holds over the cap. */
export function dayRanges(day, totalCount) {
  if (totalCount <= RUN_LIST_CAP) return [day];
  return [0, 6, 12, 18].map((h) => {
    const start = String(h).padStart(2, "0");
    const end = String(h + 5).padStart(2, "0");
    return `${day}T${start}:00:00Z..${day}T${end}:59:59Z`;
  });
}

function jsonLines(text) {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function runsQuery(repo, created, perPage) {
  return `repos/${repo}/actions/runs?created=${encodeURIComponent(created)}&per_page=${perPage}`;
}

/** Non-skipped runs created on `day`, deduplicated by id across range queries. */
export function listRunsForDay(io, repo, day) {
  const { total_count: total } = JSON.parse(io.gh(["api", runsQuery(repo, day, 1)]));
  const byId = new Map();
  for (const created of dayRanges(day, total)) {
    const page = io.gh(["api", "--paginate", "--jq", ".workflow_runs[]", runsQuery(repo, created, BATCH)]);
    for (const run of jsonLines(page)) if (run.conclusion !== "skipped") byId.set(run.id, run);
  }
  return [...byId.values()];
}

function cachePath(cacheDir, repo, runId) {
  return path.join(cacheDir, ...repo.split("/"), `${runId}.json`);
}

function pauseIfNearLimit(io) {
  const { remaining, reset } = JSON.parse(io.gh(["api", "rate_limit"])).resources.core;
  io.log(`rate limit: ${remaining} remaining, resets ${new Date(reset * 1000).toISOString()}`);
  if (remaining < RATE_FLOOR) io.sleepUntil(reset);
}

/** A run whose jobs endpoint answers 404 or 410 has aged out of the API; anything else is a real failure. */
function isGone(error) {
  return /HTTP 4(04|10)/.test(String(error?.stderr ?? error?.message ?? ""));
}

function fetchRunJobs(io, repo, run) {
  const endpoint = `repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=${BATCH}`;
  return jsonLines(io.gh(["api", "--paginate", "--jq", ".jobs[]", endpoint]));
}

/**
 * Jobs of every attempt of `runs`, each tagged with `repo`. Completed runs are cached as JSON under `cacheDir`; a run
 * still in progress is always fetched again so its partial jobs never freeze. The rate limit is read before each
 * batch of fetches, so a long backfill pauses instead of failing and a rerun resumes from the cache.
 */
export function fetchJobs(io, repo, runs, cacheDir = DEFAULT_CACHE) {
  const jobs = [];
  const missing = [];
  let fetched = 0;
  for (const run of runs) {
    const file = cachePath(cacheDir, repo, run.id);
    let runJobs = run.status === "completed" ? JSON.parse(io.readCache(file) ?? "null") : null;
    if (runJobs === null) {
      if (fetched++ % BATCH === 0) pauseIfNearLimit(io);
      try {
        runJobs = fetchRunJobs(io, repo, run);
      } catch (error) {
        if (!isGone(error)) throw error;
        missing.push({ repo, runId: run.id, day: utcDay(run.created_at) });
        continue;
      }
      if (run.status === "completed") io.writeCache(file, JSON.stringify(runJobs));
    }
    jobs.push(...runJobs.map((job) => ({ ...job, repo })));
  }
  return { jobs, missing };
}

/** Every job of every repo over `days`, plus the runs whose jobs had already aged out. */
export function collect(io, { repos, days, cacheDir = DEFAULT_CACHE }) {
  const jobs = [];
  const missing = [];
  for (const repo of repos) {
    for (const day of days) {
      const out = fetchJobs(io, repo, listRunsForDay(io, repo, day), cacheDir);
      jobs.push(...out.jobs);
      missing.push(...out.missing);
    }
  }
  return { jobs, missing };
}

/**
 * Splits a completed job into queue and run milliseconds, or null when it never waited for a runner. A skipped job
 * has no runner and completes before its recorded start. A job cancelled while still queued also has no runner,
 * but it did wait: its queue runs to completed_at and its run time is zero. Jobs not yet completed are left out.
 */
export function jobTimes(job) {
  if (job.status !== "completed" || job.conclusion === "skipped") return null;
  const created = Date.parse(job.created_at);
  const started = Date.parse(job.started_at);
  const completed = Date.parse(job.completed_at);
  if (job.runner_name == null) {
    if (job.conclusion !== "cancelled") return null;
    return { queueMs: Math.max(0, completed - created), runMs: 0, start: null, end: null };
  }
  if (completed < started) return null;
  return { queueMs: Math.max(0, started - created), runMs: completed - started, start: started, end: completed };
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * Highest number of jobs running at once on each UTC day, over half-open [started_at, completed_at) intervals, so a
 * job that ends the instant another starts does not overlap it. A job running across midnight counts toward the
 * next day's peak too.
 */
export function peakConcurrency(jobs) {
  const events = [];
  for (const job of jobs) {
    const t = jobTimes(job);
    if (t?.start == null || t.end <= t.start) continue;
    events.push([t.start, 1], [t.end, -1]);
  }
  // Ends sort before starts at the same instant: that is what makes the interval half-open.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const peaks = new Map();
  let running = 0;
  for (const [at, delta] of events) {
    const day = new Date(at).toISOString().slice(0, 10);
    if (!peaks.has(day)) peaks.set(day, running);
    running += delta;
    if (delta > 0 && running > peaks.get(day)) peaks.set(day, running);
  }
  return peaks;
}

function dayRow(repo, day, rows, peak) {
  const queues = rows.map((t) => t.queueMs / MINUTE_MS).sort((a, b) => a - b);
  return {
    repo,
    day,
    jobs: rows.length,
    queueMin: queues.reduce((a, b) => a + b, 0),
    runMin: rows.reduce((a, t) => a + t.runMs, 0) / MINUTE_MS,
    queueP50: percentile(queues, 50),
    queueP90: percentile(queues, 90),
    queueMax: queues.at(-1) ?? 0,
    peakConcurrent: peak ?? 0,
  };
}

/** One row per repo and UTC day (keyed by each job's created_at), sorted by repo then day. */
export function foldJobs(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const times = jobTimes(job);
    if (times === null) continue;
    const key = `${job.repo}\t${utcDay(job.created_at)}`;
    if (!groups.has(key)) groups.set(key, { jobs: [], times: [] });
    groups.get(key).jobs.push(job);
    groups.get(key).times.push(times);
  }
  const peaksByRepo = new Map();
  return [...groups.keys()].sort().map((key) => {
    const [repo, day] = key.split("\t");
    if (!peaksByRepo.has(repo)) peaksByRepo.set(repo, peakConcurrency(jobs.filter((j) => j.repo === repo)));
    return dayRow(repo, day, groups.get(key).times, peaksByRepo.get(repo).get(day));
  });
}

function readOrNull(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function sleepUntil(resetEpochSec) {
  const ms = Math.max(0, resetEpochSec * 1000 - Date.now()) + 1000;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Argument arrays only: gh is never handed a shell string. */
export function liveIo() {
  return {
    gh: (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 512 * 2 ** 20, stdio: ["ignore", "pipe", "pipe"] }),
    readCache: readOrNull,
    writeCache: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    },
    sleepUntil,
    log: (line) => console.error(line),
  };
}
