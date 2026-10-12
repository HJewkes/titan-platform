import { describe, expect, it } from "vitest";
import {
  collect,
  dayRanges,
  fetchJobs,
  foldJobs,
  listRunsForDay,
  peakConcurrency,
  utcDays,
} from "./ci-capacity-actions.mjs";

const AC = "HJewkes/agent-chat";

function job(overrides) {
  return {
    status: "completed",
    conclusion: "success",
    runner_name: "GitHub Actions 1",
    repo: AC,
    ...overrides,
  };
}

function lines(items) {
  return items.map((item) => JSON.stringify(item)).join("\n");
}

function fakeIo({ answers = {}, cache = {}, remaining = 5000, reset = 1_760_270_400 } = {}) {
  const calls = [];
  const written = {};
  const slept = [];
  return {
    calls,
    written,
    slept,
    gh(args) {
      calls.push(args);
      const endpoint = args.at(-1);
      if (endpoint === "rate_limit") return JSON.stringify({ resources: { core: { remaining, reset } } });
      const answer = answers[endpoint] ?? Object.entries(answers).find(([prefix]) => endpoint.startsWith(prefix))?.[1];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`unexpected gh call ${endpoint}`);
      return typeof answer === "function" ? answer(endpoint) : answer;
    },
    readCache: (file) => cache[file] ?? null,
    writeCache: (file, text) => {
      written[file] = text;
    },
    sleepUntil: (at) => slept.push(at),
    log: () => {},
  };
}

describe("ci-capacity actions fold", () => {
  it("a needs-gated job queued from 11:28:10 to 12:04:23 adds 36.2 queue min and 0.18 run min to its day", () => {
    const jobs = [
      job({
        created_at: "2026-10-12T11:28:10Z",
        started_at: "2026-10-12T12:04:23Z",
        completed_at: "2026-10-12T12:04:34Z",
      }),
    ];

    const [row] = foldJobs(jobs);

    expect(row).toMatchObject({ repo: AC, day: "2026-10-12", jobs: 1 });
    expect(row.queueMin).toBeCloseTo(36.22, 2);
    expect(row.runMin).toBeCloseTo(0.183, 3);
    expect(row.queueMax).toBeCloseTo(36.22, 2);
  });

  it("a skipped job with no runner and a completion before its start adds nothing to either sum", () => {
    const jobs = [
      job({
        conclusion: "skipped",
        runner_name: null,
        created_at: "2026-10-12T10:00:00Z",
        started_at: "2026-10-12T10:00:05Z",
        completed_at: "2026-10-12T10:00:04Z",
      }),
      job({
        created_at: "2026-10-12T10:00:00Z",
        started_at: "2026-10-12T10:01:00Z",
        completed_at: "2026-10-12T10:03:00Z",
      }),
    ];

    const [row] = foldJobs(jobs);

    expect(row.jobs).toBe(1);
    expect(row.queueMin).toBeCloseTo(1);
    expect(row.runMin).toBeCloseTo(2);
  });

  it("a job cancelled while still queued counts as queue up to its completion and as zero run", () => {
    const jobs = [
      job({
        conclusion: "cancelled",
        runner_name: null,
        created_at: "2026-10-12T10:00:00Z",
        started_at: "2026-10-12T10:20:00Z",
        completed_at: "2026-10-12T10:20:00Z",
      }),
    ];

    const [row] = foldJobs(jobs);

    expect(row.jobs).toBe(1);
    expect(row.queueMin).toBeCloseTo(20);
    expect(row.runMin).toBe(0);
    expect(row.peakConcurrent).toBe(0);
  });

  it("queue p50 and p90 use nearest rank over the day's jobs", () => {
    const jobs = Array.from({ length: 10 }, (_, i) =>
      job({
        created_at: "2026-10-12T10:00:00Z",
        started_at: new Date(Date.parse("2026-10-12T10:00:00Z") + (i + 1) * 60_000).toISOString(),
        completed_at: "2026-10-12T11:00:00Z",
      }),
    );

    const [row] = foldJobs(jobs);

    expect(row.queueP50).toBeCloseTo(5);
    expect(row.queueP90).toBeCloseTo(9);
    expect(row.queueMax).toBeCloseTo(10);
  });

  it("three jobs over 12:00-12:05 where one ends exactly as another starts peak at 2", () => {
    const jobs = [
      job({ created_at: "2026-10-12T12:00:00Z", started_at: "2026-10-12T12:00:00Z", completed_at: "2026-10-12T12:05:00Z" }),
      job({ created_at: "2026-10-12T12:00:00Z", started_at: "2026-10-12T12:00:00Z", completed_at: "2026-10-12T12:02:00Z" }),
      job({ created_at: "2026-10-12T12:00:00Z", started_at: "2026-10-12T12:02:00Z", completed_at: "2026-10-12T12:05:00Z" }),
    ];

    expect(peakConcurrency(jobs).get("2026-10-12")).toBe(2);
    expect(foldJobs(jobs)[0].peakConcurrent).toBe(2);
  });

  it("peak concurrency across repos counts jobs of every repo together, and per repo only its own", () => {
    const window = { created_at: "2026-10-12T12:00:00Z", started_at: "2026-10-12T12:00:00Z", completed_at: "2026-10-12T12:05:00Z" };
    const jobs = [job(window), job(window), job({ ...window, repo: "HJewkes/titan-design" })];

    const rows = foldJobs(jobs);

    expect(peakConcurrency(jobs).get("2026-10-12")).toBe(3);
    expect(rows.map((r) => [r.repo, r.peakConcurrent])).toEqual([
      [AC, 2],
      ["HJewkes/titan-design", 1],
    ]);
  });

  it("a job running across midnight counts toward the next day's peak", () => {
    const jobs = [
      job({ created_at: "2026-10-11T23:50:00Z", started_at: "2026-10-11T23:50:00Z", completed_at: "2026-10-12T00:30:00Z" }),
      job({ created_at: "2026-10-12T00:10:00Z", started_at: "2026-10-12T00:10:00Z", completed_at: "2026-10-12T00:20:00Z" }),
    ];

    const peaks = peakConcurrency(jobs);

    expect(peaks.get("2026-10-11")).toBe(1);
    expect(peaks.get("2026-10-12")).toBe(2);
  });
});

describe("ci-capacity actions collector", () => {
  it("a day reporting 1400 runs is listed as four 6-hour ranges whose union is deduplicated by run id", () => {
    const run = (id) => ({ id, status: "completed", conclusion: "success", created_at: "2026-10-07T06:00:00Z" });
    const io = fakeIo({
      answers: {
        "repos/HJewkes/titan-platform/actions/runs?created=2026-10-07&per_page=1": JSON.stringify({ total_count: 1400 }),
        "repos/HJewkes/titan-platform/actions/runs?created=2026-10-07T": (endpoint) =>
          endpoint.includes("T00%3A00") ? lines([run(1), run(2)]) : lines([run(2), run(3)]),
      },
    });

    const runs = listRunsForDay(io, "HJewkes/titan-platform", "2026-10-07");

    expect(dayRanges("2026-10-07", 1400)).toEqual([
      "2026-10-07T00:00:00Z..2026-10-07T05:59:59Z",
      "2026-10-07T06:00:00Z..2026-10-07T11:59:59Z",
      "2026-10-07T12:00:00Z..2026-10-07T17:59:59Z",
      "2026-10-07T18:00:00Z..2026-10-07T23:59:59Z",
    ]);
    expect(io.calls.filter((args) => args.includes("--paginate"))).toHaveLength(4);
    expect(runs.map((r) => r.id).sort()).toEqual([1, 2, 3]);
  });

  it("a day under the cap is one query and skipped runs are dropped", () => {
    const io = fakeIo({
      answers: {
        "repos/HJewkes/agent-chat/actions/runs?created=2026-10-07&per_page=1": JSON.stringify({ total_count: 2 }),
        "repos/HJewkes/agent-chat/actions/runs?created=2026-10-07&per_page=100": lines([
          { id: 1, conclusion: "success" },
          { id: 2, conclusion: "skipped" },
        ]),
      },
    });

    const runs = listRunsForDay(io, AC, "2026-10-07");

    expect(runs.map((r) => r.id)).toEqual([1]);
  });

  it("a cached completed run is not fetched again, while an in-progress run is fetched and never cached", () => {
    const cached = `/c/HJewkes/agent-chat/1.json`;
    const io = fakeIo({
      cache: { [cached]: JSON.stringify([{ id: 10 }]), "/c/HJewkes/agent-chat/2.json": JSON.stringify([{ id: 99 }]) },
      answers: {
        "repos/HJewkes/agent-chat/actions/runs/2/jobs?filter=all": lines([{ id: 20 }]),
        "repos/HJewkes/agent-chat/actions/runs/3/jobs?filter=all": lines([{ id: 30 }]),
      },
    });
    const runs = [
      { id: 1, status: "completed", created_at: "2026-10-07T01:00:00Z" },
      { id: 2, status: "in_progress", created_at: "2026-10-07T01:00:00Z" },
      { id: 3, status: "completed", created_at: "2026-10-07T01:00:00Z" },
    ];

    const { jobs } = fetchJobs(io, AC, runs, "/c");

    expect(jobs.map((j) => j.id)).toEqual([10, 20, 30]);
    expect(jobs.every((j) => j.repo === AC)).toBe(true);
    expect(io.calls.some((args) => args.at(-1).includes("runs/1/"))).toBe(false);
    expect(Object.keys(io.written)).toEqual(["/c/HJewkes/agent-chat/3.json"]);
  });

  it("the jobs fetch asks for every attempt with filter=all", () => {
    const io = fakeIo({ answers: { "repos/HJewkes/agent-chat/actions/runs/7/jobs": lines([]) } });

    fetchJobs(io, AC, [{ id: 7, status: "completed", created_at: "2026-10-07T01:00:00Z" }], "/c");

    expect(io.calls.at(-1).at(-1)).toBe("repos/HJewkes/agent-chat/actions/runs/7/jobs?filter=all&per_page=100");
  });

  it("a rate limit with 150 remaining sleeps until its reset before the next batch", () => {
    const io = fakeIo({ remaining: 150, answers: { "repos/HJewkes/agent-chat/actions/runs/": lines([]) } });

    fetchJobs(io, AC, [{ id: 1, status: "completed", created_at: "2026-10-07T01:00:00Z" }], "/c");

    expect(io.slept).toEqual([1_760_270_400]);
    expect(io.calls.findIndex((a) => a.at(-1) === "rate_limit")).toBeLessThan(
      io.calls.findIndex((a) => a.at(-1).includes("/jobs")),
    );
  });

  it("a rate limit at 200 remaining does not sleep", () => {
    const io = fakeIo({ remaining: 200, answers: { "repos/HJewkes/agent-chat/actions/runs/": lines([]) } });

    fetchJobs(io, AC, [{ id: 1, status: "completed", created_at: "2026-10-07T01:00:00Z" }], "/c");

    expect(io.slept).toEqual([]);
  });

  it("a run whose jobs answer HTTP 404 is reported missing on its day instead of failing the backfill", () => {
    const io = fakeIo({
      answers: {
        "repos/HJewkes/agent-chat/actions/runs?created=2026-10-05&per_page=1": JSON.stringify({ total_count: 1 }),
        "repos/HJewkes/agent-chat/actions/runs?created=2026-10-05&per_page=100": lines([
          { id: 5, status: "completed", conclusion: "success", created_at: "2026-10-05T03:00:00Z" },
        ]),
        "repos/HJewkes/agent-chat/actions/runs/5/jobs": Object.assign(new Error("gh failed"), { stderr: "gh: Not Found (HTTP 404)" }),
      },
    });

    const out = collect(io, { repos: [AC], days: ["2026-10-05"], cacheDir: "/c" });

    expect(out.jobs).toEqual([]);
    expect(out.missing).toEqual([{ repo: AC, runId: 5, day: "2026-10-05" }]);
  });

  it("utcDays lists both ends of the window", () => {
    expect(utcDays("2026-10-05", "2026-10-11")).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
  });
});
