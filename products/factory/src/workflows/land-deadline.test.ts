import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { landRoutes } from "./land.js";
import { REPO } from "../test-support/land.js";

const MIN = 60_000;
const POLL_MS = 30_000;
const TIMEOUT_MS = 10 * MIN;
const JUMP_MS = 3 * 60 * MIN;
const MAX_SLEEPS = 1_000;

interface Harness {
  fake: FakeGitHub;
  clock: { now: number };
  polls: number[];
  wakes: number[];
  ciWait(): Promise<{ ok: boolean; error?: string; output?: string }>;
}

/** A fake clock whose `jumpAtSleep`-th sleep also overshoots by `jumpMs`, and a PR whose mergeable_state stays unknown. */
function harness(options: { jumpAtSleep?: number; greenAfterMs?: number } = {}): Harness {
  const fake = fakeGitHub();
  fake.addPr({ headSha: fakeSha("head1"), mergeableState: "unknown" });
  fake.setRuns(fakeSha("head1"), [successRun("validate", 1)]);
  const clock = { now: 0 };
  const polls: number[] = [];
  const wakes: number[] = [];
  let sleeps = 0;
  let jumpedAt: number | undefined;
  fake.onGetPr = (pr) => {
    polls.push(clock.now);
    const turnedGreen = jumpedAt !== undefined && options.greenAfterMs !== undefined && clock.now >= jumpedAt + options.greenAfterMs;
    if (turnedGreen) pr.mergeableState = "clean";
  };
  const routes = landRoutes({
    port: githubPort(fake.wire),
    now: () => clock.now,
    sleep: async (ms) => {
      if (++sleeps > MAX_SLEEPS) throw new Error("runaway polling");
      clock.now += ms + (sleeps === options.jumpAtSleep ? JUMP_MS : 0);
      if (sleeps === options.jumpAtSleep) jumpedAt = clock.now;
      wakes.push(clock.now);
    },
    pollMs: POLL_MS,
    ciTimeoutMs: TIMEOUT_MS,
  });
  const route = routes.find((candidate) => candidate.match === "ci-wait")!;
  const prompt = JSON.stringify({ repo: REPO, pr: 1, contexts: ["validate"], strict: false });
  const ciWait = () =>
    route.runner.run({ runId: "r", workflowName: "w", stepId: "ci-wait", iteration: 0, prompt, signal: new AbortController().signal, attempt: 1, requestKey: "k" }) as never;
  return { fake, clock, polls, wakes, ciWait };
}

describe("ci-wait deadline", () => {
  it("returns green when the re-poll after a 3 h clock jump finds CI done", async () => {
    const h = harness({ jumpAtSleep: 3, greenAfterMs: 2 * MIN });

    const outcome = await h.ciWait();

    expect(outcome.ok).toBe(true);
    expect(JSON.parse(outcome.output!).result.verdict).toBe("green");
  });

  it("polls exactly once more, at least 2 minutes after the wake, when CI is still unfinished after the jump", async () => {
    const h = harness({ jumpAtSleep: 3 });

    const outcome = await h.ciWait();

    const wake = h.wakes[2]!;
    const pollsAfterWake = h.polls.filter((at) => at >= wake);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("timed out");
    expect(pollsAfterWake).toHaveLength(2);
    expect(pollsAfterWake[1]! - wake).toBeGreaterThanOrEqual(2 * MIN);
  });

  it("times out at the deadline when the clock never jumps", async () => {
    const h = harness();

    const outcome = await h.ciWait();

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("timed out");
    expect(h.clock.now).toBeGreaterThanOrEqual(TIMEOUT_MS);
    expect(h.clock.now).toBeLessThan(TIMEOUT_MS + POLL_MS);
  });
});

describe("ci-wait on a blocked head whose bypass read fails", () => {
  it("polls again after a thrown read and turns green once the read succeeds", async () => {
    const h = harness();
    h.fake.pr(1).mergeableState = "blocked";
    h.fake.onGetPr = undefined;
    let reads = 0;
    h.fake.wire.reviewRulesBypassable = async () => {
      if (++reads === 1) throw new Error("HTTP 500");
      return true;
    };

    const outcome = await h.ciWait();

    expect(outcome.ok).toBe(true);
    expect(JSON.parse(outcome.output!).result.verdict).toBe("green");
    expect(reads).toBe(2);
  });

  it("times out with the read error when the read never succeeds", async () => {
    const h = harness();
    h.fake.pr(1).mergeableState = "blocked";
    h.fake.wire.reviewRulesBypassable = async () => {
      throw new Error("HTTP 500");
    };

    const outcome = await h.ciWait();

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("HTTP 500");
  });
});
