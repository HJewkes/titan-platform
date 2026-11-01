import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import type { RoutedStepInput } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { landRoutes } from "./land.js";
import { REPO } from "../test-support/land.js";

const MIN = 60_000;
const POLL_MS = 30_000;
const TIMEOUT_MS = 45 * MIN;
const T0 = 1_800_000_000_000;
const HEAD = fakeSha("resumed-ci-head");

const Outcome = z.object({ ok: z.boolean(), error: z.string().optional(), output: z.string().optional() });
const queued = (name: string, id: number): CheckRun => ({ ...successRun(name, id), status: "queued", conclusion: null });

/** ci-wait over checks that never settle, re-dispatched after a restart when `firstStartedAt` is given. */
async function ciWait(runs: CheckRun[], firstStartedAt?: number) {
  const fake = fakeGitHub();
  fake.rules = { contexts: ["validate"], strict: false };
  fake.addPr({ headSha: HEAD, mergeableState: "clean" });
  fake.setRuns(HEAD, runs);
  const clock = { now: T0 };
  const route = landRoutes({ port: githubPort(fake.wire), now: () => clock.now, sleep: async (ms) => void (clock.now += ms), pollMs: POLL_MS, ciTimeoutMs: TIMEOUT_MS }).find((candidate) => candidate.match === "ci-wait");
  if (!route) throw new Error("no ci-wait route");
  const restart = firstStartedAt === undefined ? {} : { firstStartedAt: new Date(firstStartedAt).toISOString(), restarts: 1 };
  const step: RoutedStepInput = { runId: "r", workflowName: "w", stepId: "ci-wait", iteration: 0, prompt: JSON.stringify({ repo: REPO, pr: 1, contexts: ["validate"], strict: false }), signal: new AbortController().signal, attempt: firstStartedAt === undefined ? 0 : 1, requestKey: "k", ...restart };
  const outcome = Outcome.parse(await route.runner.run(step));
  const result = outcome.output ? z.object({ result: z.object({ verdict: z.string() }) }).parse(JSON.parse(outcome.output)).result : undefined;
  return { ...outcome, result, elapsed: clock.now - T0 };
}

describe("ci-wait re-dispatched after a restart", () => {
  it("times out about a minute after the restart when the first try began 44 min earlier", async () => {
    const out = await ciWait([], T0 - (TIMEOUT_MS - MIN));

    expect(out.error).toContain("timed out");
    expect(out.elapsed).toBeGreaterThanOrEqual(MIN);
    expect(out.elapsed).toBeLessThanOrEqual(MIN + POLL_MS);
  });

  it("gives up on a backlog at the ceiling counted from the first start", async () => {
    const out = await ciWait([queued("validate", 1)], T0 - (TIMEOUT_MS - MIN));

    expect(out.error).toContain("CI backlog");
    expect(out.elapsed).toBeGreaterThanOrEqual(2 * TIMEOUT_MS + MIN);
    expect(out.elapsed).toBeLessThanOrEqual(2 * TIMEOUT_MS + MIN + POLL_MS);
  });

  it("waits the whole timeout on a first run", async () => {
    const out = await ciWait([]);

    expect(out.error).toContain("timed out");
    expect(out.elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS);
  });
});

describe("ci-wait re-dispatched after the head's checks already concluded", () => {
  const RESTARTED_AFTER = 2 * 60 * MIN;

  it("finishes green within one poll when every required check already passed", async () => {
    const out = await ciWait([successRun("validate", 1)], T0 - RESTARTED_AFTER);

    expect(out.result?.verdict).toBe("green");
    expect(out.elapsed).toBeLessThanOrEqual(POLL_MS);
  });

  it("finishes red within one poll when a required check already failed", async () => {
    const out = await ciWait([successRun("validate", 1, undefined, "failure")], T0 - RESTARTED_AFTER);

    expect(out.result?.verdict).toBe("red");
    expect(out.elapsed).toBeLessThanOrEqual(POLL_MS);
  });
});
