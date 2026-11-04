import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkBudget, fetchRuns, parseArgs, percentile, renderMarkdown, roundHalfEven, selectRuns, summarize } from "./ci-timing.mjs";

const RUNS = JSON.parse(readFileSync(new URL("./fixtures/ci-timing/runs.json", import.meta.url), "utf8"));
const BUDGET = JSON.parse(readFileSync(new URL("../.github/ci-budget.json", import.meta.url), "utf8"));

const rowFor = (rows, match) => rows.find((row) => Object.entries(match).every(([key, value]) => row[key] === value) && (match.step ? true : row.step === undefined));

describe("ci timing percentiles", () => {
  it("interpolates between the closest ranks", () => {
    expect(percentile([1000, 600, 700], 0.5)).toBe(700);
    expect(percentile([1000, 600, 700], 0.9)).toBeCloseTo(940);
    expect(percentile([42], 0.9)).toBe(42);
  });

  it("rounds an exact half to the even neighbour", () => {
    expect([roundHalfEven(524.5), roundHalfEven(2350.5), roundHalfEven(1864.6), roundHalfEven(3.5)]).toEqual([524, 2350, 1865, 4]);
  });

  it("summarizes run wall, job, queue and step per event", () => {
    const rows = summarize(RUNS);

    expect(rowFor(rows, { event: "pull_request", kind: "run" })).toMatchObject({ n: 3, p50: 704, p90: 965, max: 1030 });
    expect(rowFor(rows, { event: "pull_request", kind: "job", job: "validate" })).toMatchObject({ n: 3, p50: 700, p90: 940, max: 1000 });
    expect(rowFor(rows, { event: "pull_request", kind: "queue", job: "validate" })).toMatchObject({ n: 3, p50: 4, p90: 25, max: 30 });
    expect(rowFor(rows, { event: "pull_request", kind: "step", job: "validate", step: "Run pnpm build" })).toMatchObject({ n: 3, p50: 100, p90: 180, max: 200 });
    expect(rowFor(rows, { event: "push", kind: "job", job: "validate" })).toMatchObject({ n: 1, p90: 2000 });
  });

  it("takes no sample from a skipped job or step", () => {
    const rows = summarize(RUNS);

    expect(rowFor(rows, { event: "pull_request", kind: "step", job: "validate", step: "Require a changeset" })).toMatchObject({ n: 2, max: 5 });
    expect(rowFor(rows, { event: "push", kind: "job", job: "dag-check" })).toBeUndefined();
  });
});

describe("ci timing budget", () => {
  const budget = (entries) => ({ budgets: entries });

  it("passes a stat at its ceiling and fails one over it", () => {
    const rows = summarize(RUNS);

    const results = checkBudget(rows, budget([
      { event: "pull_request", job: "validate", p90: 940 },
      { event: "pull_request", job: "validate", step: "Run pnpm build", p50: 99, max: 200 },
    ]));

    expect(results.map(({ stat, actual, ok }) => [stat, actual, ok])).toEqual([["p90", 940, true], ["p50", 100, false], ["max", 200, true]]);
  });

  it("fails an entry that matches no runs, so a renamed job cannot pass", () => {
    const [result] = checkBudget(summarize(RUNS), budget([{ event: "push", job: "dag-check", p90: 600 }]));

    expect(result).toMatchObject({ actual: null, ok: false });
  });

  it("caps the run wall and the queue through kind", () => {
    const results = checkBudget(summarize(RUNS), budget([
      { event: "pull_request", p90: 960 },
      { event: "pull_request", kind: "queue", job: "validate", p90: 25 },
    ]));

    expect(results.map(({ kind, ok }) => [kind, ok])).toEqual([["run", false], ["queue", true]]);
  });

  it("marks an over-budget stat in the summary", () => {
    const rows = summarize(RUNS);
    const markdown = renderMarkdown(rows, checkBudget(rows, budget([{ event: "push", job: "validate", p90: 720 }])));

    expect(markdown).toContain("| **over** | main | validate | p90 | 2000 | 720 |");
    expect(markdown).toContain("| PR | validate / (queue) | 3 | 4 | 25 | 30 |");
  });

  it("caps only PR and main events in the checked-in budget", () => {
    expect(BUDGET.budgets.length).toBeGreaterThan(0);
    for (const entry of BUDGET.budgets) expect(["pull_request", "push"]).toContain(entry.event);
  });
});

describe("ci timing run selection", () => {
  it("keeps the newest runs that had finished by the cutoff", () => {
    const chosen = selectRuns(RUNS.filter((run) => run.event === "pull_request"), 2, "2026-01-05T11:30:00Z");

    expect(chosen.map((run) => run.databaseId)).toEqual([102, 101]);
  });

  it("lists main as pushes to main and views each chosen run", () => {
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      if (args[1] === "list") return JSON.stringify(RUNS.filter((run) => run.event === args[args.indexOf("--event") + 1]).map(({ jobs: _jobs, ...run }) => run));
      return JSON.stringify({ jobs: RUNS.find((run) => String(run.databaseId) === args[2]).jobs });
    };
    const options = parseArgs(["--repo", "example/repo", "--pr-runs", "1", "--main-runs", "1", "--created", "2026-01-05..2026-01-06"], BUDGET);

    const runs = fetchRuns(gh, options);

    expect(runs.map((run) => [run.databaseId, run.jobs.length])).toEqual([[103, 2], [104, 2]]);
    const pushList = calls.find((args) => args[1] === "list" && args.includes("push"));
    expect(pushList).toEqual(expect.arrayContaining(["--branch", "main", "--workflow", "ci.yml", "--status", "success", "--created", "2026-01-05..2026-01-06"]));
    expect(calls.filter((args) => args[1] === "view")).toHaveLength(2);
  });

  it("requires a repo", () => {
    expect(() => parseArgs([], BUDGET)).toThrow("--repo");
  });
});
