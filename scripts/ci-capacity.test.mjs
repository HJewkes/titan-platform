import { describe, expect, it } from "vitest";
import { buildReport, defaultWindow, headerRateLimitIo, minutesAtCap, parseArgs, renderReport } from "./ci-capacity.mjs";

function running(repo, start, end) {
  return {
    repo,
    name: "verify",
    status: "completed",
    conclusion: "success",
    runner_name: "GitHub Actions 1",
    created_at: start,
    started_at: start,
    completed_at: end,
  };
}

function fold(repo, day, overrides = {}) {
  return { repo, day, jobs: 3, queueMin: 12.345, runMin: 7, queueP50: 1, queueP90: 4.26, queueMax: 9, peakConcurrent: 2, ...overrides };
}

describe("default window", () => {
  it("covers the seven complete UTC days before now and leaves today's partial day out", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");

    expect(defaultWindow(now)).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    expect(parseArgs([], now)).toMatchObject({
      from: "2026-10-05",
      to: "2026-10-11",
      repos: ["HJewkes/titan-design", "HJewkes/titan-platform", "HJewkes/agent-chat"],
      thresholdMin: 10,
      cap: 20,
    });
  });

  it("lets flags override the window and repos", () => {
    const options = parseArgs(["--from", "2026-10-01", "--to", "2026-10-02", "--repos", "a/b,c/d"], 0);

    expect(options).toMatchObject({ from: "2026-10-01", to: "2026-10-02", repos: ["a/b", "c/d"] });
  });
});

describe("report render", () => {
  const days = ["2026-10-05", "2026-10-06"];
  const repos = ["HJewkes/agent-chat", "HJewkes/titan-design"];
  const peaks = { named: new Map([["2026-10-05", 4]]), namedAtCap: new Map() };

  it("prints fixed headers and one-decimal minutes for a two-repo, two-day fold", () => {
    const markdown = renderReport({ days, repos, perRepoDay: [fold("HJewkes/agent-chat", "2026-10-05")], peaks, timeouts: [] });

    expect(markdown).toContain(
      "| repo | day | jobs | queue min | run min | p90 queue | max queue | peak concurrent | runs aged out |",
    );
    expect(markdown).toContain("| HJewkes/agent-chat | 2026-10-05 | 3 | 12.3 | 7.0 | 4.3 | 9.0 | 2 | 0 |");
    expect(markdown).toContain("| 2026-10-05 | 4 | 0.0 |");
  });

  it("fills a day with no jobs with zeros rather than leaving it out", () => {
    const markdown = renderReport({ days, repos, perRepoDay: [fold("HJewkes/agent-chat", "2026-10-05")], peaks, timeouts: [] });

    expect(markdown).toContain("| HJewkes/titan-design | 2026-10-06 | 0 | 0.0 | 0.0 | 0.0 | 0.0 | 0 | 0 |");
    expect(markdown).toContain("| 2026-10-06 | 0 | 0.0 |");
    expect(markdown).toContain("| hjewkes/agent-chat | 2026-10-06 | 0 | 0 | 0 |");
  });

  it("counts timeouts by cause and prints one evidence line each", () => {
    const timeout = {
      repo: "hjewkes/agent-chat",
      pr: 722,
      endAt: "2026-10-06T12:13:27.844Z",
      form: "prefixed",
      cause: "queue",
      evidence: "std / verify queued 36.6 min of 45.0",
      queueMin: 36.6,
      runMin: 2,
    };

    const markdown = renderReport({ days, repos, perRepoDay: [], peaks, timeouts: [timeout] });

    expect(markdown).toContain("| hjewkes/agent-chat | 2026-10-06 | 1 | 0 | 0 |");
    expect(markdown).toContain(
      "- 2026-10-06T12:13:27.844Z hjewkes/agent-chat#722 (prefixed) **queue**: std / verify queued 36.6 min of 45.0 [queue 36.6 / run 2.0 min]",
    );
  });

  it("shows aged-out runs per repo and day so a trimmed day is visible", () => {
    const missing = [{ repo: "HJewkes/agent-chat", runId: 1, day: "2026-10-05" }];

    const markdown = renderReport({ days, repos, perRepoDay: [fold("HJewkes/agent-chat", "2026-10-05")], peaks, timeouts: [], missing });

    expect(markdown).toContain("| HJewkes/agent-chat | 2026-10-05 | 3 | 12.3 | 7.0 | 4.3 | 9.0 | 2 | 1 |");
  });
});

describe("minutes at the concurrency cap", () => {
  it("counts only the span during which the cap is reached, split at UTC midnight", () => {
    const jobs = [
      running("a/b", "2026-10-05T23:50:00Z", "2026-10-06T00:20:00Z"),
      running("a/b", "2026-10-05T23:55:00Z", "2026-10-06T00:05:00Z"),
      running("a/b", "2026-10-06T00:05:00Z", "2026-10-06T00:30:00Z"),
    ];

    const atCap = minutesAtCap(jobs, 2);

    expect(atCap.get("2026-10-05")).toBeCloseTo(5);
    expect(atCap.get("2026-10-06")).toBeCloseTo(20);
  });
});

describe("report build", () => {
  function fakeIo(calls) {
    const job = running("ignored", "2026-10-05T10:00:00Z", "2026-10-05T10:10:00Z");
    return {
      gh: (args) => {
        calls.push(args.join(" "));
        const endpoint = args.at(-1);
        if (endpoint === "rate_limit") return JSON.stringify({ resources: { core: { remaining: 5000, reset: 0 } } });
        if (endpoint.includes("/jobs?")) return JSON.stringify({ ...job, created_at: "2026-10-05T09:58:00Z" });
        if (endpoint.endsWith("per_page=1")) return JSON.stringify({ total_count: 1 });
        return JSON.stringify({ id: endpoint.length, status: "completed", conclusion: "success", created_at: "2026-10-05T09:58:00Z" });
      },
      sqlite: (args) => {
        calls.push(`sqlite3 ${args[0]}`);
        return "[]";
      },
      readCache: () => null,
      writeCache: () => {},
      sleepUntil: () => {},
      log: () => {},
    };
  }

  it("collects the named repos, opens the DB read-only, and renders their jobs", () => {
    const calls = [];
    const options = { ...parseArgs(["--from", "2026-10-05", "--to", "2026-10-05", "--repos", "a/b"], 0), db: "f.sqlite3" };

    const markdown = buildReport(fakeIo(calls), options);

    expect(calls).toContain("sqlite3 -readonly");
    expect(calls.some((c) => c.includes("repos/a/b/actions/runs/"))).toBe(true);
    expect(markdown).toContain("| a/b | 2026-10-05 | 1 | 2.0 | 10.0 | 2.0 | 2.0 | 1 | 0 |");
    expect(markdown).not.toContain("all pool repos");
  });

  it("adds a pool column only when pool repos are given, merging their jobs and fetching just the extra ones", () => {
    const calls = [];
    const argv = ["--from", "2026-10-05", "--to", "2026-10-05", "--repos", "a/b", "--pool-repos", "a/b,c/d"];

    const markdown = buildReport(fakeIo(calls), { ...parseArgs(argv, 0), db: "f.sqlite3" });

    expect(markdown).toContain("| 2026-10-05 | 1 | 0.0 | 2 | 0.0 |");
    expect(calls.filter((c) => c.includes("repos/a/b/actions/runs?created") && c.endsWith("per_page=1")).length).toBe(1);
    expect(calls.some((c) => c.includes("repos/c/d/actions/runs/"))).toBe(true);
  });
});

describe("rate limit read", () => {
  const refused = "HTTP/2.0 403 Forbidden\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 1791824976\n\n{}";

  it("reads the limit from a refused Actions probe's headers, not the shimmed rate_limit endpoint", () => {
    const calls = [];
    const io = {
      gh: (args) => {
        calls.push(args.join(" "));
        if (args[1] === "rate_limit") return JSON.stringify({ resources: { core: { remaining: 5000, reset: 0 } } });
        throw Object.assign(new Error("HTTP 403"), { stdout: refused });
      },
    };

    const answer = JSON.parse(headerRateLimitIo(io, "a/b").gh(["api", "rate_limit"]));

    expect(answer.resources.core).toEqual({ remaining: 0, reset: 1791824976 });
    expect(calls).toEqual(["api -i repos/a/b/actions/runs?per_page=1"]);
  });

  it("passes every other call through unchanged", () => {
    const io = { gh: (args) => `echo ${args.join(" ")}` };

    expect(headerRateLimitIo(io, "a/b").gh(["api", "repos/a/b/actions/runs/1/jobs"])).toBe("echo api repos/a/b/actions/runs/1/jobs");
  });
});
