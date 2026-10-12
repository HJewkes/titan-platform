// TP-2450 slice c: the CI capacity CLI. Backfills Actions jobs (slice a) and Shepherd ci-wait timeouts (slice b) over
// whole UTC days and renders one markdown report for the owner's self-hosted-runner vs plan-upgrade decision.
// It only reads: gh api GETs, a jobs cache under --cache, and factory.sqlite3 opened -readonly.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CACHE, collect, foldJobs, jobTimes, peakConcurrency, utcDays } from "./ci-capacity-actions.mjs";
import {
  DEFAULT_DB,
  DEFAULT_QUEUE_THRESHOLD_MIN,
  attributeTimeouts,
  foldTimeouts,
  liveIo,
  readTimeouts,
} from "./ci-capacity-timeouts.mjs";

export const DEFAULT_REPOS = ["HJewkes/titan-design", "HJewkes/titan-platform", "HJewkes/agent-chat"];
// The Free plan's concurrent standard-job cap. The plan cannot be read through the API, so the report shows it as the
// line the peaks are compared against, not as a fact about the account.
export const DEFAULT_CAP = 20;
// Calls left to the rest of the machine: Shepherd and the coordinators spend the same per-user REST quota.
export const DEFAULT_RATE_RESERVE = 1000;
const WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** The last WINDOW_DAYS complete UTC days before `now`: today, still partial, is never included. */
export function defaultWindow(now) {
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  return { from: iso(today - WINDOW_DAYS * DAY_MS), to: iso(today - DAY_MS) };
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function list(value) {
  return value === undefined ? undefined : value.split(",").filter(Boolean);
}

export function parseArgs(argv, now) {
  const window = defaultWindow(now);
  return {
    from: flag(argv, "--from") ?? window.from,
    to: flag(argv, "--to") ?? window.to,
    repos: list(flag(argv, "--repos")) ?? DEFAULT_REPOS,
    poolRepos: list(flag(argv, "--pool-repos")) ?? [],
    db: flag(argv, "--db") ?? DEFAULT_DB,
    cacheDir: flag(argv, "--cache") ?? DEFAULT_CACHE,
    thresholdMin: Number(flag(argv, "--queue-threshold-min") ?? DEFAULT_QUEUE_THRESHOLD_MIN),
    cap: Number(flag(argv, "--cap") ?? DEFAULT_CAP),
    rateReserve: Number(flag(argv, "--rate-reserve") ?? DEFAULT_RATE_RESERVE),
  };
}

/** Minutes per UTC day during which at least `cap` jobs ran at once, over the same half-open intervals as the peak. */
export function minutesAtCap(jobs, cap) {
  const events = [];
  for (const job of jobs) {
    const t = jobTimes(job);
    if (t?.start == null || t.end <= t.start) continue;
    events.push([t.start, 1], [t.end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const atCap = new Map();
  let running = 0;
  for (let i = 0; i < events.length; i++) {
    running += events[i][1];
    const next = events[i + 1]?.[0];
    if (running >= cap && next !== undefined) addSpan(atCap, events[i][0], next);
  }
  return atCap;
}

function addSpan(byDay, start, end) {
  for (let t = start; t < end; ) {
    const day = new Date(t).toISOString().slice(0, 10);
    const dayEnd = Date.parse(`${day}T00:00:00Z`) + DAY_MS;
    const stop = Math.min(end, dayEnd);
    byDay.set(day, (byDay.get(day) ?? 0) + (stop - t) / MINUTE_MS);
    t = stop;
  }
}

const one = (n) => n.toFixed(1);

function table(header, rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

const EMPTY_DAY = { jobs: 0, queueMin: 0, runMin: 0, queueP90: 0, queueMax: 0, peakConcurrent: 0 };

function repoDayTable(days, repos, perRepoDay, missing) {
  const rows = [];
  for (const repo of repos) {
    for (const day of days) {
      const r = perRepoDay.find((x) => x.repo === repo && x.day === day) ?? EMPTY_DAY;
      const gone = missing.filter((m) => m.repo === repo && m.day === day).length;
      rows.push([repo, day, r.jobs, one(r.queueMin), one(r.runMin), one(r.queueP90), one(r.queueMax), r.peakConcurrent, gone]);
    }
  }
  const header = ["repo", "day", "jobs", "queue min", "run min", "p90 queue", "max queue", "peak concurrent", "runs aged out"];
  return table(header, rows);
}

function peakTable(days, peaks, cap) {
  const header = ["day", "peak concurrent (named repos)", `min at >= ${cap}`];
  const hasPool = peaks.pool !== undefined;
  if (hasPool) header.push("peak concurrent (all pool repos)", `pool min at >= ${cap}`);
  const rows = days.map((day) => {
    const row = [day, peaks.named.get(day) ?? 0, one(peaks.namedAtCap.get(day) ?? 0)];
    if (hasPool) row.push(peaks.pool.get(day) ?? 0, one(peaks.poolAtCap.get(day) ?? 0));
    return row;
  });
  return table(header, rows);
}

function timeoutTable(days, repos, timeouts) {
  const counts = foldTimeouts(timeouts);
  const timeoutRepos = [...new Set([...repos.map((r) => r.toLowerCase()), ...counts.map((c) => c.repo)])].sort();
  const rows = [];
  for (const repo of timeoutRepos) {
    for (const day of days) {
      const c = counts.find((x) => x.repo === repo && x.day === day) ?? { queue: 0, "slow-run": 0, "no-run": 0 };
      rows.push([repo, day, c.queue, c["slow-run"], c["no-run"]]);
    }
  }
  return table(["repo", "day", "queue", "slow-run", "no-run"], rows);
}

function evidenceLines(timeouts) {
  if (timeouts.length === 0) return "No ci-wait timeouts in the window.";
  return timeouts
    .map((t) => `- ${t.endAt} ${t.repo}#${t.pr} (${t.form}) **${t.cause}**: ${t.evidence} [queue ${one(t.queueMin)} / run ${one(t.runMin)} min]`)
    .join("\n");
}

/** The whole report as markdown. Every repo and day gets a row, so a quiet day shows zeros rather than a gap. */
export function renderReport({ days, repos, perRepoDay, peaks, timeouts, missing = [], cap = DEFAULT_CAP }) {
  return [
    `## Jobs per repo and UTC day (${days[0]}..${days.at(-1)})`,
    "Minutes; queue is job created_at to started_at, skipped jobs excluded, every attempt counted.",
    repoDayTable(days, repos, perRepoDay, missing),
    "## Peak concurrent running jobs across repos",
    peakTable(days, peaks, cap),
    "## Shepherd ci-wait timeouts by cause",
    timeoutTable(days, repos, timeouts),
    "## Timeout evidence",
    evidenceLines(timeouts),
    "",
  ].join("\n\n");
}

function header(text, name) {
  return Number(new RegExp(`^${name}:\\s*(\\d+)`, "im").exec(text)?.[1]);
}

/**
 * Answers slice a's `gh api rate_limit` from the X-RateLimit headers of a real one-row Actions call. Agent sessions
 * reach gh through agent-chat's shim, whose rate_limit answer stayed at 5000 remaining while Actions calls were
 * already refused (2026-10-12), so the pause never fired. A refused probe still carries the headers. `reserve` is
 * hidden from the remaining count, so the pause leaves that many calls to the other sessions on the account.
 */
export function headerRateLimitIo(io, probeRepo, reserve = 0) {
  const probe = ["api", "-i", `repos/${probeRepo}/actions/runs?per_page=1`];
  const gh = (args) => {
    if (args.length !== 2 || args[1] !== "rate_limit") return io.gh(args);
    let text;
    try {
      text = io.gh(probe);
    } catch (error) {
      text = String(error?.stdout ?? "");
    }
    const core = { remaining: header(text, "X-Ratelimit-Remaining") - reserve, reset: header(text, "X-Ratelimit-Reset") };
    if (Number.isNaN(core.remaining) || Number.isNaN(core.reset)) throw new Error(`no X-RateLimit headers from ${probe[2]}`);
    return JSON.stringify({ resources: { core } });
  };
  return { ...io, gh };
}

function poolPeaks(io, options, days, namedJobs) {
  if (options.poolRepos.length === 0) return {};
  const extra = options.poolRepos.filter((r) => !options.repos.includes(r));
  const { jobs } = collect(io, { repos: extra, days, cacheDir: options.cacheDir });
  const all = [...namedJobs, ...jobs];
  return { pool: peakConcurrency(all), poolAtCap: minutesAtCap(all, options.cap) };
}

/** Collects, attributes and renders; returns the markdown. */
export function buildReport(io, options) {
  const days = utcDays(options.from, options.to);
  const { jobs, missing } = collect(io, { repos: options.repos, days, cacheDir: options.cacheDir });
  const events = readTimeouts(io, options.db, options.from, options.to);
  const timeouts = attributeTimeouts(io, events, { cacheDir: options.cacheDir, thresholdMin: options.thresholdMin });
  const peaks = {
    named: peakConcurrency(jobs),
    namedAtCap: minutesAtCap(jobs, options.cap),
    ...poolPeaks(io, options, days, jobs),
  };
  return renderReport({ days, repos: options.repos, perRepoDay: foldJobs(jobs), peaks, timeouts, missing, cap: options.cap });
}

/** Returns the exit code. */
export function runCli(argv, io = liveIo(), now = Date.now()) {
  if (argv.includes("--help")) {
    console.error(
      "usage: ci-capacity.mjs [--from YYYY-MM-DD --to YYYY-MM-DD] [--repos owner/a,owner/b] [--pool-repos ...]\n" +
        "         [--db factory.sqlite3] [--cache dir] [--queue-threshold-min 10] [--cap 20] [--rate-reserve 1000]",
    );
    return 2;
  }
  const options = parseArgs(argv, now);
  process.stdout.write(buildReport(headerRateLimitIo(io, options.repos[0], options.rateReserve), options));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
