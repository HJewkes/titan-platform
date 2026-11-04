import { describe, expect, it } from "vitest";
import { ciWait, type CiWaitOptions } from "./ci-wait.js";
import { fakeGitHub, fakeSha, successRun, type FakeGitHub } from "./fake.js";
import { githubPort, type CheckRun, type GitHubWire } from "./port.js";

const SHA = fakeSha("head");
const queued = (name: string): CheckRun => ({ ...successRun(name, 1), status: "queued", conclusion: null });

/** A clock that moves only when the loop sleeps; `between(n)` runs after the n-th sleep, so a test can move the world between polls. */
function world(fake: FakeGitHub, between: (sleeps: number) => void = () => {}, wire: GitHubWire = fake.wire) {
  let now = 0;
  let sleeps = 0;
  const errors: unknown[] = [];
  const run = (overrides: Partial<CiWaitOptions> = {}) =>
    ciWait(githubPort(wire), {
      repo: "o/r",
      sha: SHA,
      timeoutSeconds: 540,
      intervalSeconds: 30,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        between(++sleeps);
      },
      onReadError: (error) => errors.push(error),
      ...overrides,
    });
  return { run, errors, sleeps: () => sleeps };
}

function noRules(fake: FakeGitHub): FakeGitHub {
  fake.rules = { contexts: [], strict: false };
  return fake;
}

describe("ciWait", () => {
  it("polls until a pending run lands green", async () => {
    const fake = noRules(fakeGitHub());
    fake.setRuns(SHA, [queued("build")]);
    const { run, sleeps } = world(fake, () => fake.setRuns(SHA, [successRun("build", 1)]));

    expect(await run()).toEqual({ outcome: "green", line: `GREEN o/r ${SHA}` });
    expect(sleeps()).toBe(1);
  });

  it("waits for unfinished jobs before it reports red, then names every failure", async () => {
    const fake = noRules(fakeGitHub());
    fake.setRuns(SHA, [queued("slow"), successRun("bad", 2, undefined, "failure")]);
    const { run, sleeps } = world(fake, () => fake.setRuns(SHA, [successRun("slow", 1), successRun("bad", 2, undefined, "failure")]));

    expect(await run()).toEqual({ outcome: "red", line: `RED o/r ${SHA}: bad=failure` });
    expect(sleeps()).toBe(1);
  });

  it("times out naming the pending jobs when the next poll would pass the deadline", async () => {
    const fake = noRules(fakeGitHub());
    fake.setRuns(SHA, [queued("build"), queued("deploy")]);

    expect(await world(fake).run({ timeoutSeconds: 60 })).toEqual({ outcome: "timeout", line: `TIMEOUT o/r ${SHA} after 60s: pending build, deploy` });
  });

  it("times out on an empty list, saying nothing was reported", async () => {
    const fake = noRules(fakeGitHub());
    fake.commits.set(SHA, { sha: SHA, parents: [] });

    expect((await world(fake).run({ timeoutSeconds: 1, intervalSeconds: 1 })).line).toBe(`TIMEOUT o/r ${SHA} after 1s: pending (nothing reported yet)`);
  });

  it("polls both the check-runs and the combined status", async () => {
    const fake = noRules(fakeGitHub());
    fake.setRuns(SHA, [successRun("build", 1)]);
    fake.statuses.set(SHA, [{ context: "ci/legacy", state: "failure" }]);

    expect(await world(fake).run()).toEqual({ outcome: "red", line: `RED o/r ${SHA}: ci/legacy=failure` });
    expect(fake.calls).toEqual(expect.arrayContaining(["listCheckRuns", "listCommitStatuses"]));
  });

  it("expands an abbreviated sha and polls and prints the full one", async () => {
    const fake = noRules(fakeGitHub());
    fake.setRuns(SHA, [successRun("build", 1)]);

    expect(await world(fake).run({ sha: SHA.slice(0, 7) })).toEqual({ outcome: "green", line: `GREEN o/r ${SHA}` });
  });

  it("ends at once on a sha GitHub does not have, before any poll", async () => {
    const fake = noRules(fakeGitHub());

    expect(await world(fake).run({ sha: "abc1234" })).toEqual({ outcome: "unknown-sha", line: "need a full 40-hex sha of a pushed commit: no commit abc1234 in o/r" });
    expect(fake.calls).not.toContain("listCheckRuns");
  });

  it("ends on a full sha GitHub does not have instead of timing out on its pending status", async () => {
    const fake = noRules(fakeGitHub());

    expect((await world(fake).run({ timeoutSeconds: 60, intervalSeconds: 1 })).outcome).toBe("unknown-sha");
  });

  it("retries a failed lookup, then polls", async () => {
    const fake = noRules(fakeGitHub());
    fake.setRuns(SHA, [successRun("build", 1)]);
    fake.readFaults.resolveCommit = [new Error("HTTP 502")];
    const { run, errors } = world(fake);

    expect(await run({ sha: SHA.slice(0, 7) })).toEqual({ outcome: "green", line: `GREEN o/r ${SHA}` });
    expect(errors).toHaveLength(1);
  });

  it("retries a failed lookup until GitHub says the commit does not exist", async () => {
    const fake = noRules(fakeGitHub());
    fake.readFaults.resolveCommit = [new Error("HTTP 502")];

    expect((await world(fake).run({ sha: "abc1234" })).outcome).toBe("unknown-sha");
  });

  it("treats a failed check-run read as transient", async () => {
    const fake = noRules(fakeGitHub());
    fake.setRuns(SHA, [successRun("build", 1)]);
    fake.readFaults.listCheckRuns = [new SyntaxError("Unexpected token")];
    const { run, errors } = world(fake);

    expect((await run()).outcome).toBe("green");
    expect(errors).toHaveLength(1);
  });

  it("times out, never red, while every read fails", async () => {
    const fake = noRules(fakeGitHub());
    fake.setRuns(SHA, [successRun("build", 1)]);
    fake.readFaults.listCheckRuns = Array.from({ length: 10 }, () => new Error("HTTP 502"));

    expect((await world(fake).run({ timeoutSeconds: 1, intervalSeconds: 1 })).line).toBe(`TIMEOUT o/r ${SHA} after 1s: pending (no successful poll)`);
  });

  it.each(["getBranchRules", "getClassicRequiredChecks"] as const)("never judges without the required list while %s fails", async (read) => {
    const fake = noRules(fakeGitHub());
    fake.setRuns(SHA, [successRun("build", 1)]);
    fake.readFaults[read] = Array.from({ length: 10 }, () => new Error("HTTP 500"));

    expect((await world(fake).run({ timeoutSeconds: 1, intervalSeconds: 1 })).outcome).toBe("timeout");
  });

  it("re-reads the rules each poll but resolves the default branch once, and goes green when the required runs land", async () => {
    const fake = fakeGitHub();
    fake.rules = { contexts: ["dag-check", "validate"], strict: true };
    const early = [successRun("build", 1)];
    const queuedRuns = [...early, queued("dag-check"), queued("validate")];
    const landed = [...early, successRun("dag-check", 2), successRun("validate", 3)];
    fake.setRuns(SHA, early);
    const { run, sleeps } = world(fake, (n) => fake.setRuns(SHA, n === 1 ? queuedRuns : landed));

    expect((await run()).outcome).toBe("green");
    expect(sleeps()).toBe(2);
    expect(fake.calls.filter((call) => call === "getBranchRules")).toHaveLength(3);
    expect(fake.calls.filter((call) => call === "getDefaultBranch")).toHaveLength(1);
  });

  it("reads the rules of --base instead of the default branch", async () => {
    const fake = noRules(fakeGitHub({ base: "trunk" }));
    fake.setRuns(SHA, [successRun("build", 1)]);
    const branches: string[] = [];
    const wire: GitHubWire = { ...fake.wire, getBranchRules: (repo, branch) => (branches.push(branch), fake.wire.getBranchRules(repo, branch)) };

    await world(fake, undefined, wire).run();
    await world(fake, undefined, wire).run({ base: "release/1.x" });

    expect(branches).toEqual(["trunk", "release/1.x"]);
    expect(fake.calls.filter((call) => call === "getDefaultBranch")).toHaveLength(1);
  });

  describe("when the required contexts change mid-wait", () => {
    const startWith = (contexts: string[]) => {
      const fake = fakeGitHub();
      fake.rules = { contexts, strict: true };
      fake.setRuns(SHA, [successRun("validate", 1)]);
      return fake;
    };
    const timeoutLine = `TIMEOUT o/r ${SHA} after 540s: pending egress-scan`;

    it("goes green when a context is dropped", async () => {
      const fake = startWith(["validate", "egress-scan"]);
      const { run, sleeps } = world(fake, () => (fake.rules = { contexts: ["validate"], strict: true }));

      expect((await run()).outcome).toBe("green");
      expect(sleeps()).toBe(1);
    });

    it("keeps the recorded list when the re-read fails", async () => {
      const fake = startWith(["validate", "egress-scan"]);
      const { run, errors } = world(fake, () => {
        fake.rules = { contexts: ["validate"], strict: true };
        fake.readFaults.getBranchRules = Array.from({ length: 20 }, () => new Error("HTTP 500"));
      });

      expect((await run()).line).toBe(timeoutLine);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("keeps the recorded list when the re-read comes back empty", async () => {
      const fake = startWith(["validate", "egress-scan"]);
      const { run } = world(fake, () => (fake.rules = { contexts: [], strict: false }));

      expect((await run()).line).toBe(timeoutLine);
    });

    it("judges a context added after the first poll", async () => {
      const fake = startWith(["validate"]);
      fake.setRuns(SHA, [queued("validate")]);
      const { run } = world(fake, () => {
        fake.setRuns(SHA, [successRun("validate", 1), successRun("lint", 2, undefined, "failure")]);
        fake.rules = { contexts: ["validate", "lint"], strict: true };
      });

      expect(await run()).toEqual({ outcome: "red", line: `RED o/r ${SHA}: lint=failure` });
    });
  });
});
