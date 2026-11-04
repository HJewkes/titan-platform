// CI wall-time percentiles against a budget (TP-4436 S8). Reads the last successful runs of one workflow with
// `gh run list` and `gh run view --json jobs`, computes p50, p90 and max per run, job, job queue and step, and fails
// when a stat in .github/ci-budget.json is over its ceiling. It only reads.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EVENTS = { pull_request: "PR", push: "main" };
const STATS = ["p50", "p90", "max"];

const seconds = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;

/** Linear interpolation between closest ranks, numpy's default, so the numbers match a notebook over the same runs. */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p * (sorted.length - 1);
  const low = Math.floor(at);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

/** Half to even, so an exact .5 does not always round up. */
export function roundHalfEven(value) {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

const ran = (entry) => entry.conclusion !== "skipped" && entry.startedAt && entry.completedAt;

/** One sample per run, job, job queue and step: [key, seconds]. A skipped job or step is no sample. */
export function samples(run) {
  const out = [[{ event: run.event, kind: "run" }, seconds(run.createdAt, run.updatedAt)]];
  for (const job of run.jobs.filter(ran)) {
    out.push([{ event: run.event, kind: "job", job: job.name }, seconds(job.startedAt, job.completedAt)]);
    out.push([{ event: run.event, kind: "queue", job: job.name }, seconds(run.createdAt, job.startedAt)]);
    for (const step of job.steps.filter(ran)) {
      out.push([{ event: run.event, kind: "step", job: job.name, step: step.name }, seconds(step.startedAt, step.completedAt)]);
    }
  }
  return out;
}

const keyOf = ({ event, kind, job = "", step = "" }) => [event, kind, job, step].join("\t");

/** p50, p90 and max over every sample key, in first-seen order. */
export function summarize(runs) {
  const groups = new Map();
  for (const [key, value] of runs.flatMap(samples)) {
    const id = keyOf(key);
    if (!groups.has(id)) groups.set(id, { ...key, values: [] });
    groups.get(id).values.push(value);
  }
  return [...groups.values()].map(({ values, ...key }) => ({
    ...key,
    n: values.length,
    p50: roundHalfEven(percentile(values, 0.5)),
    p90: roundHalfEven(percentile(values, 0.9)),
    max: Math.max(...values),
  }));
}

const kindOf = (entry) => entry.kind ?? (entry.step ? "step" : entry.job ? "job" : "run");

/** One result per stat a budget entry caps. An entry that matches no row fails: a renamed job must not pass silently. */
export function checkBudget(rows, budget) {
  return budget.budgets.flatMap((entry) => {
    const key = keyOf({ event: entry.event, kind: kindOf(entry), job: entry.job, step: entry.step });
    const row = rows.find((candidate) => keyOf(candidate) === key);
    return STATS.filter((stat) => entry[stat] !== undefined).map((stat) => {
      const actual = row ? row[stat] : null;
      return { ...entry, kind: kindOf(entry), stat, limit: entry[stat], actual, ok: actual !== null && actual <= entry[stat] };
    });
  });
}

const label = (row) => [row.kind === "run" ? "run wall" : row.job, row.kind === "queue" ? "(queue)" : row.step].filter(Boolean).join(" / ");

export function renderMarkdown(rows, results) {
  const table = (kinds) => rows.filter((row) => kinds.includes(row.kind)).map((row) => `| ${EVENTS[row.event] ?? row.event} | ${label(row)} | ${row.n} | ${row.p50} | ${row.p90} | ${row.max} |`);
  const head = ["| event | what | runs | p50 s | p90 s | max s |", "|---|---|---|---|---|---|"];
  const budget = results.map((r) => `| ${r.ok ? "ok" : "**over**"} | ${EVENTS[r.event] ?? r.event} | ${label(r)} | ${r.stat} | ${r.actual ?? "no runs"} | ${r.limit} |`);
  return [
    "### CI timing",
    "",
    ...head,
    ...table(["run", "job", "queue"]),
    "",
    "#### Steps",
    "",
    ...head,
    ...table(["step"]),
    "",
    "#### Budget",
    "",
    "| result | event | what | stat | actual s | ceiling s |",
    "|---|---|---|---|---|---|",
    ...budget,
    "",
  ].join("\n");
}

/** The newest `count` runs that had finished by `finishedBefore`, when given. */
export function selectRuns(runs, count, finishedBefore) {
  const done = finishedBefore ? runs.filter((run) => Date.parse(run.updatedAt) <= Date.parse(finishedBefore)) : runs;
  return [...done].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, count);
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function parseArgs(argv, budget) {
  const repo = flag(argv, "--repo");
  if (!repo) throw new Error("--repo <owner/name> is required");
  return {
    repo,
    workflow: flag(argv, "--workflow") ?? budget.workflow,
    counts: { pull_request: Number(flag(argv, "--pr-runs") ?? budget.runs.pull_request), push: Number(flag(argv, "--main-runs") ?? budget.runs.push) },
    created: flag(argv, "--created"),
    finishedBefore: flag(argv, "--finished-before"),
    summary: flag(argv, "--summary"),
  };
}

const LIST_FIELDS = "databaseId,createdAt,updatedAt,event";

/** Successful runs per event through `gh`; main means pushes to main. */
export function fetchRuns(gh, options) {
  return Object.entries(options.counts).flatMap(([event, count]) => {
    const args = ["run", "list", "--repo", options.repo, "--workflow", options.workflow, "--status", "success", "--event", event, "--limit", "200", "--json", LIST_FIELDS];
    if (event === "push") args.push("--branch", "main");
    if (options.created) args.push("--created", options.created);
    const chosen = selectRuns(JSON.parse(gh(args)), count, options.finishedBefore);
    return chosen.map((run) => ({ ...run, ...JSON.parse(gh(["run", "view", String(run.databaseId), "--repo", options.repo, "--json", "jobs"])) }));
  });
}

const liveGh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function main(argv) {
  const budgetPath = flag(argv, "--budget") ?? fileURLToPath(new URL("../.github/ci-budget.json", import.meta.url));
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  const options = parseArgs(argv, budget);
  const rows = summarize(fetchRuns(liveGh, options));
  const results = checkBudget(rows, budget);
  const markdown = renderMarkdown(rows, results);
  console.log(markdown);
  if (options.summary) appendFileSync(options.summary, markdown);
  const over = results.filter((result) => !result.ok);
  for (const result of over) console.error(`over budget: ${EVENTS[result.event]} ${label(result)} ${result.stat} ${result.actual ?? "no runs"} s > ${result.limit} s`);
  return over.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
