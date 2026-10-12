// TP-2450 slice b: the Shepherd side of the CI capacity measurement. Reads every ci-wait timeout from factory.sqlite3
// (only ever opened -readonly) and decides whether the branch's Actions jobs spent the wait queued for a runner.
// Shepherd's own backlog flag cannot answer this: it only fires when every awaited check already exists, so a
// needs-gated check that was never created (ac#722) hides a queue behind a plain timeout.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_CACHE, fetchJobs, liveIo as actionsIo } from "./ci-capacity-actions.mjs";

export const DEFAULT_DB = path.join(homedir(), ".local", "state", "titan-factory", "factory.sqlite3");
export const DEFAULT_QUEUE_THRESHOLD_MIN = 10;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// Mirrors products/factory/src/shepherd/failure-class.ts and workflows/land-ci-wait.ts rather than importing them:
// scripts must not depend on a product's dist. The tests pin the three texts so drift shows up there.
// The give-up form is tried first because its row may carry any class prefix.
const FORMS = [
  { form: "backlog", pattern: /\bci-wait gave up after (\d+) ms on a CI backlog\b/ },
  { form: "prefixed", pattern: /^\[ci-timeout\] .*\bci-wait timed out after (\d+) ms\b/s },
  { form: "legacy", pattern: /^step ci-wait\b.*\bci-wait timed out after (\d+) ms\b/s },
];
const WAITING_ON = /waiting on (.*)$/s;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The ci-wait timeout form of an error text and its wait length, or null when the row is some other failure. */
export function matchTimeout(error) {
  for (const { form, pattern } of FORMS) {
    const match = pattern.exec(error ?? "");
    if (match) return { form, windowMs: Number(match[1]) };
  }
  return null;
}

/** Check names after the last "waiting on"; a mergeable_state fallback names no check, so it gives none. */
export function waitingOn(error) {
  const tail = WAITING_ON.exec(error.split("; ").at(-1) ?? "")?.[1];
  if (tail === undefined || tail.startsWith("mergeable_state")) return [];
  return tail.split(", ").map((name) => name.trim()).filter(Boolean);
}

/** One failed shepherd-pr row as a timeout event, or null when its error is not a ci-wait timeout. */
export function parseTimeout(row) {
  const matched = matchTimeout(row.error);
  if (matched === null) return null;
  const params = JSON.parse(row.params);
  return {
    id: row.id,
    repo: String(params.repo).toLowerCase(),
    pr: Number(params.pr),
    branch: params.branch,
    endAt: row.completed_at,
    windowMs: matched.windowMs,
    waitingOn: waitingOn(row.error),
    form: matched.form,
  };
}

/** The argv for sqlite3; the days are checked first because they are spliced into the SQL text. */
export function timeoutQueryArgs(db, from, to) {
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) throw new Error(`days must be YYYY-MM-DD, got ${from}..${to}`);
  const end = new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS).toISOString();
  const sql =
    "SELECT id, params, error, completed_at FROM workflow_run" +
    " WHERE workflow_name = 'shepherd-pr' AND status = 'failed'" +
    ` AND completed_at >= '${from}T00:00:00.000Z' AND completed_at < '${end}'` +
    " AND error LIKE '%ci-wait%' ORDER BY completed_at";
  return ["-readonly", "-json", db, sql];
}

/** Every ci-wait timeout whose run ended on a UTC day from `from` to `to`, both inclusive. */
export function readTimeouts(io, db, from, to) {
  const text = io.sqlite(timeoutQueryArgs(db, from, to)).trim();
  const rows = text ? JSON.parse(text) : [];
  return rows.map(parseTimeout).filter((event) => event !== null);
}

/**
 * The queue and run intervals of a job, in epoch ms, with open ends closed at `endAt`. A job still unstarted when it
 * was read, or cancelled while queued, counts as queued to its end; skipped jobs never waited and give null.
 */
export function jobIntervals(job, endAt) {
  if (job.conclusion === "skipped") return null;
  const created = Date.parse(job.created_at);
  const completed = job.completed_at ? Date.parse(job.completed_at) : endAt;
  if (job.runner_name == null || !job.started_at) {
    if (job.status === "completed" && job.conclusion !== "cancelled") return null;
    return { queue: [created, completed], run: null };
  }
  const started = Date.parse(job.started_at);
  if (completed < started) return null;
  return { queue: [created, Math.max(created, started)], run: [started, completed] };
}

function overlap([a, b], [lo, hi]) {
  return Math.max(0, Math.min(b, hi) - Math.max(a, lo));
}

function longest(jobs, endAt, window, side) {
  let best = { name: null, ms: 0 };
  for (const job of jobs) {
    const interval = jobIntervals(job, endAt)?.[side];
    const ms = interval ? overlap(interval, window) : 0;
    if (ms > best.ms) best = { name: job.name, ms };
  }
  return best;
}

const minutes = (ms) => (ms / MINUTE_MS).toFixed(1);

/**
 * Classifies one timeout from the jobs of its branch's runs: `queue` when some job sat queued inside the wait for at
 * least `thresholdMin`, `no-run` when no job touched the wait at all (a trigger or config gap), else `slow-run`. The
 * window, not the branch, decides relevance, so runs of an earlier registration on a reused branch fall away.
 */
export function attribute(event, jobs, thresholdMin = DEFAULT_QUEUE_THRESHOLD_MIN) {
  const endAt = Date.parse(event.endAt);
  const window = [endAt - event.windowMs, endAt];
  const of = `of ${minutes(event.windowMs)}`;
  const queued = longest(jobs, endAt, window, "queue");
  const ran = longest(jobs, endAt, window, "run");
  const raw = { queueMin: queued.ms / MINUTE_MS, runMin: ran.ms / MINUTE_MS };
  if (queued.ms >= thresholdMin * MINUTE_MS) {
    return { ...event, ...raw, cause: "queue", evidence: `${queued.name} queued ${minutes(queued.ms)} min ${of}` };
  }
  if (queued.ms === 0 && ran.ms === 0) {
    return { ...event, ...raw, cause: "no-run", evidence: `no job on ${event.branch} overlapped the ${minutes(event.windowMs)} min wait` };
  }
  const queuePart = queued.name ? `; longest queue ${queued.name} ${minutes(queued.ms)} min` : "; no queue";
  const runPart = ran.name ? `${ran.name} ran ${minutes(ran.ms)} min ${of}` : `nothing ran ${of}`;
  return { ...event, ...raw, cause: "slow-run", evidence: `${runPart}${queuePart}` };
}

/** Non-skipped runs of `branch` created in the day before the wait began up to its end. */
export function listBranchRuns(io, event) {
  const endAt = Date.parse(event.endAt);
  const from = new Date(endAt - event.windowMs - DAY_MS).toISOString();
  const created = `${from.slice(0, 19)}Z..${new Date(endAt).toISOString().slice(0, 19)}Z`;
  const endpoint =
    `repos/${event.repo}/actions/runs?branch=${encodeURIComponent(event.branch)}` +
    `&created=${encodeURIComponent(created)}&per_page=100`;
  const page = io.gh(["api", "--paginate", "--jq", ".workflow_runs[]", endpoint]);
  return page
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((run) => run.conclusion !== "skipped");
}

/** Each timeout attributed against its branch's jobs, reusing slice a's jobs cache and rate-limit pause. */
export function attributeTimeouts(io, events, { cacheDir = DEFAULT_CACHE, thresholdMin = DEFAULT_QUEUE_THRESHOLD_MIN } = {}) {
  return events.map((event) => {
    const { jobs, missing } = fetchJobs(io, event.repo, listBranchRuns(io, event), cacheDir);
    const attributed = attribute(event, jobs, thresholdMin);
    return missing.length ? { ...attributed, evidence: `${attributed.evidence}; ${missing.length} run(s) aged out` } : attributed;
  });
}

/** Counts per repo and UTC day of the wait's end, sorted by repo then day. */
export function foldTimeouts(attributed) {
  const groups = new Map();
  for (const event of attributed) {
    const key = `${event.repo}\t${event.endAt.slice(0, 10)}`;
    if (!groups.has(key)) groups.set(key, { queue: 0, "slow-run": 0, "no-run": 0 });
    groups.get(key)[event.cause] += 1;
  }
  return [...groups.keys()].sort().map((key) => {
    const [repo, day] = key.split("\t");
    return { repo, day, ...groups.get(key) };
  });
}

/** Slice a's gh and cache IO plus sqlite3, still argument arrays only. */
export function liveIo() {
  return {
    ...actionsIo(),
    sqlite: (args) => execFileSync("sqlite3", args, { encoding: "utf8", maxBuffer: 256 * 2 ** 20, stdio: ["ignore", "pipe", "pipe"] }),
  };
}
