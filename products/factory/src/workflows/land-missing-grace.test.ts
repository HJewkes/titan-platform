import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { MISSING_CHECK_GRACE_MS, landRoutes } from "./land.js";
import { REPO } from "../test-support/land.js";

const MIN = 60_000;
const POLL_MS = 30_000;
const HEAD = fakeSha("head1");

/** A strict repo whose PR is behind at HEAD, shown `runs`; `ciWait` polls on a fake clock and reports when it returned. */
function harness(runs: CheckRun[], options: { behind?: boolean; graceMs?: number } = {}) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeableState: options.behind === false ? "blocked" : "behind", behind: options.behind ?? true });
  fake.setRuns(HEAD, runs);
  const clock = { now: 0 };
  const routes = landRoutes({
    port: githubPort(fake.wire),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    pollMs: POLL_MS,
    ciTimeoutMs: 20 * MIN,
    missingCheckGraceMs: options.graceMs,
  });
  const route = routes.find((candidate) => candidate.match === "ci-wait")!;
  const prompt = JSON.stringify({ repo: REPO, pr: 1, contexts: ["validate", "dag-check"], strict: true });
  const ciWait = async () => {
    const out = (await route.runner.run({ runId: "r", workflowName: "w", stepId: "ci-wait", iteration: 0, prompt, signal: new AbortController().signal, attempt: 1, requestKey: "k" })) as { ok: boolean; output?: string; error?: string };
    return { ...out, result: out.output ? JSON.parse(out.output).result : undefined };
  };
  return { ciWait, clock };
}

const running = (name: string, id: number): CheckRun => ({ ...successRun(name, id), status: "queued", conclusion: null });

describe("ci-wait on a strict behind head with a required check that never reported", () => {
  it("reads pending until the grace passes, then settles behind so update-branch runs", async () => {
    const h = harness([successRun("validate", 1)]);

    const out = await h.ciWait();

    expect(out.result).toMatchObject({ verdict: "behind", headSha: HEAD });
    expect(out.result.checksGreen).toBeUndefined();
    expect(h.clock.now).toBeGreaterThanOrEqual(MISSING_CHECK_GRACE_MS);
    expect(h.clock.now).toBeLessThan(MISSING_CHECK_GRACE_MS + POLL_MS);
  });

  it("honours a grace passed through deps", async () => {
    const h = harness([successRun("validate", 1)], { graceMs: 2 * MIN });

    await h.ciWait();

    expect(h.clock.now).toBeGreaterThanOrEqual(2 * MIN);
    expect(h.clock.now).toBeLessThan(2 * MIN + POLL_MS);
  });

  it("keeps waiting past the grace while a required check is queued or running", async () => {
    const h = harness([successRun("validate", 1), running("dag-check", 2)]);

    const out = await h.ciWait();

    expect(out.ok).toBe(false);
    expect(out.error).toContain("timed out");
    expect(out.error).toContain("dag-check");
  });

  it("decides identically on a second run over the same clock and ledger inputs", async () => {
    const first = await harness([successRun("validate", 1)]).ciWait();
    const second = await harness([successRun("validate", 1)]).ciWait();

    expect(second.output).toBe(first.output);
  });
});

describe("ci-wait on a head that is not behind", () => {
  it("is not settled by the grace: a missing check still reads pending to the timeout", async () => {
    const h = harness([successRun("validate", 1)], { behind: false });

    const out = await h.ciWait();

    expect(out.ok).toBe(false);
    expect(out.error).toContain("dag-check");
  });
});
