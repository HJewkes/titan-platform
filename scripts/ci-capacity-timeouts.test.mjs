import { describe, expect, it } from "vitest";
import { attribute, attributeTimeouts, foldTimeouts, parseTimeout, readTimeouts } from "./ci-capacity-timeouts.mjs";

const PREFIXED =
  "[ci-timeout] step ci-wait:0 (iteration 0) failed: ci-wait timed out after 2700000 ms: waiting on check, std / verify";
const LEGACY = "step ci-wait:6 (iteration 0) failed: ci-wait timed out after 2700000 ms: waiting on check";
const BACKLOG =
  "[other] step ci-wait:r1:0 (iteration 0) failed: ci-wait gave up after 8100000 ms on a CI backlog: checks still queued or running, none red; waiting on validate, dag-check";

function row(error, overrides = {}) {
  return {
    id: "run-1",
    params: JSON.stringify({ repo: "HJewkes/agent-chat", pr: "722", branch: "agent-chat/tc-cc-1121-a" }),
    error,
    completed_at: "2026-10-12T12:13:27.844Z",
    ...overrides,
  };
}

const at = (time) => (time === null ? null : `2026-10-12T${time}Z`);

function job(name, created, started, completed, overrides = {}) {
  return {
    name,
    status: "completed",
    conclusion: "success",
    runner_name: "GitHub Actions 1",
    created_at: at(created),
    started_at: at(started),
    completed_at: at(completed),
    ...overrides,
  };
}

const AC722 = parseTimeout(row(PREFIXED));

describe("ci-capacity timeout parsing", () => {
  it("reads the prefixed, legacy and backlog give-up texts with their wait lengths and awaited checks", () => {
    const [prefixed, legacy, backlog] = [PREFIXED, LEGACY, BACKLOG].map((error) => parseTimeout(row(error)));

    expect(prefixed).toMatchObject({ form: "prefixed", windowMs: 2_700_000, waitingOn: ["check", "std / verify"] });
    expect(legacy).toMatchObject({ form: "legacy", windowMs: 2_700_000, waitingOn: ["check"] });
    expect(backlog).toMatchObject({ form: "backlog", windowMs: 8_100_000, waitingOn: ["validate", "dag-check"] });
  });

  it("ignores other failures and a mergeable_state wait names no check", () => {
    const blocked = parseTimeout(row("step ci-wait:1 (iteration 0) failed: ci-wait timed out after 2700000 ms: waiting on mergeable_state blocked"));

    expect(parseTimeout(row("[land-rules] step land-rules:0 failed: blocked"))).toBeNull();
    expect(blocked.waitingOn).toEqual([]);
  });

  it("opens the database only with -readonly and lower-cases the repo", () => {
    const argv = [];
    const io = {
      sqlite: (args) => {
        argv.push(...args);
        return JSON.stringify([row(PREFIXED), row(LEGACY, { params: JSON.stringify({ repo: "hjewkes/agent-chat", pr: "1", branch: "b" }) })]);
      },
    };

    const events = readTimeouts(io, "/x/factory.sqlite3", "2026-10-05", "2026-10-11");

    expect(argv.slice(0, 3)).toEqual(["-readonly", "-json", "/x/factory.sqlite3"]);
    expect(argv[3]).toContain("completed_at < '2026-10-12T00:00:00.000Z'");
    expect(events.map((e) => e.repo)).toEqual(["hjewkes/agent-chat", "hjewkes/agent-chat"]);
  });

  it("refuses a day that is not YYYY-MM-DD before it reaches the SQL", () => {
    const io = { sqlite: () => "[]" };

    expect(() => readTimeouts(io, "db", "2026-10-05' OR 1=1 --", "2026-10-11")).toThrow(/YYYY-MM-DD/);
  });
});

describe("ci-capacity timeout attribution", () => {
  it("files ac#722 as queue: std / verify sat queued 36 of 45 min and the gated check never existed", () => {
    const jobs = [
      job("std / verify", "11:28:10", "12:04:23", "12:10:00"),
      job("std / secrets", "11:28:10", "11:50:00", "11:51:00"),
    ];

    const result = attribute(AC722, jobs);

    expect(result.cause).toBe("queue");
    expect(result.evidence).toBe("std / verify queued 35.9 min of 45.0");
  });

  it("counts a job still unstarted at the end of the wait as queued until then", () => {
    const jobs = [job("std / verify", "11:20:00", null, null, { status: "queued", runner_name: null })];

    expect(attribute(AC722, jobs)).toMatchObject({ cause: "queue", queueMin: 45 });
  });

  it("files a short queue and a long run as slow-run", () => {
    const jobs = [job("build", "11:30:00", "11:32:00", "12:12:00")];

    const result = attribute(AC722, jobs);

    expect(result.cause).toBe("slow-run");
    expect(result.evidence).toContain("build ran 40.0 min of 45.0");
  });

  it("files a queue of exactly the threshold as queue and one just under as slow-run", () => {
    const atThreshold = job("q", "11:40:00", "11:50:00", "11:51:00");
    const under = job("q", "11:40:00", "11:49:59", "11:51:00");

    expect(attribute(AC722, [atThreshold]).cause).toBe("queue");
    expect(attribute(AC722, [under]).cause).toBe("slow-run");
  });

  it("files a wait no job overlapped as no-run, ignoring a reused branch's earlier run and skipped jobs", () => {
    const jobs = [
      job("old", "09:00:00", "09:30:00", "10:00:00"),
      job("skip", "11:40:00", "11:40:00", "11:39:59", { conclusion: "skipped", runner_name: null }),
    ];

    expect(attribute(AC722, jobs).cause).toBe("no-run");
  });

  it("lists the branch's runs, reads their jobs through the cache and folds per repo and day", () => {
    const endpoints = [];
    const answers = {
      runs: JSON.stringify({ id: 9, status: "completed", conclusion: "failure", created_at: "2026-10-12T11:28:00Z" }),
      jobs: JSON.stringify(job("std / verify", "11:28:10", "12:04:23", "12:10:00")),
    };
    const io = {
      gh: (args) => {
        const endpoint = args.at(-1);
        endpoints.push(endpoint);
        if (endpoint === "rate_limit") return JSON.stringify({ resources: { core: { remaining: 5000, reset: 0 } } });
        return endpoint.includes("/jobs?") ? answers.jobs : answers.runs;
      },
      readCache: () => null,
      writeCache: () => {},
      sleepUntil: () => {},
      log: () => {},
    };
    const other = { ...AC722, repo: "hjewkes/agent-chat", branch: "x", endAt: "2026-10-13T01:00:00.000Z" };

    const attributed = attributeTimeouts(io, [AC722, other], { cacheDir: "/c" });

    expect(endpoints[0]).toContain("repos/hjewkes/agent-chat/actions/runs?branch=agent-chat%2Ftc-cc-1121-a&created=");
    expect(attributed.map((a) => a.cause)).toEqual(["queue", "no-run"]);
    expect(foldTimeouts(attributed)).toEqual([
      { repo: "hjewkes/agent-chat", day: "2026-10-12", queue: 1, "slow-run": 0, "no-run": 0 },
      { repo: "hjewkes/agent-chat", day: "2026-10-13", queue: 0, "slow-run": 0, "no-run": 1 },
    ]);
  });
});
