import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { landRoutes } from "./land.js";
import { REPO } from "../test-support/land.js";

const MIN = 60_000;
const POLL_MS = 30_000;
const TIMEOUT_MS = 45 * MIN;
const HEAD = fakeSha("head1");

const running = (name: string, id: number, status: "queued" | "in_progress"): CheckRun => ({ ...successRun(name, id), status, conclusion: null });
const red = (name: string, id: number): CheckRun => ({ ...successRun(name, id), conclusion: "failure" });

/** A PR whose checks are `before` until `turnsAtMs` on the fake clock, then `after`; no real timer runs. */
function harness(before: CheckRun[], options: { after?: CheckRun[]; turnsAtMs?: number } = {}) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeableState: "clean" });
  fake.setRuns(HEAD, before);
  const clock = { now: 0 };
  const route = landRoutes({
    port: githubPort(fake.wire),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      if (options.after && clock.now >= (options.turnsAtMs ?? 0)) fake.setRuns(HEAD, options.after);
    },
    pollMs: POLL_MS,
    ciTimeoutMs: TIMEOUT_MS,
  }).find((candidate) => candidate.match === "ci-wait")!;
  const prompt = JSON.stringify({ repo: REPO, pr: 1, contexts: ["validate"], strict: false });
  const ciWait = async () => {
    const out = (await route.runner.run({ runId: "r", workflowName: "w", stepId: "ci-wait", iteration: 0, prompt, signal: new AbortController().signal, attempt: 1, requestKey: "k" })) as { ok: boolean; output?: string; error?: string };
    return { ...out, result: out.output ? JSON.parse(out.output).result : undefined };
  };
  return { ciWait, clock };
}

describe("ci-wait when its timeout passes with checks queued or running", () => {
  it("keeps waiting through a 45 min queued backlog and returns green once it clears", async () => {
    const h = harness([running("validate", 1, "queued")], { after: [successRun("validate", 1)], turnsAtMs: 50 * MIN });

    const out = await h.ciWait();

    expect(out.ok).toBe(true);
    expect(out.result.verdict).toBe("green");
    expect(h.clock.now).toBeGreaterThan(TIMEOUT_MS);
  });

  it("ends past the ceiling with a reason that names the backlog", async () => {
    const h = harness([running("validate", 1, "in_progress")]);

    const out = await h.ciWait();

    expect(out.ok).toBe(false);
    expect(out.error).toContain("CI backlog");
    expect(out.error).toContain("validate");
    expect(out.error).not.toContain("timed out");
    expect(h.clock.now).toBeGreaterThanOrEqual(3 * TIMEOUT_MS);
    expect(h.clock.now).toBeLessThan(3 * TIMEOUT_MS + POLL_MS);
  });

  it("returns a red check found after the first timeout as red", async () => {
    const h = harness([running("validate", 1, "queued")], { after: [red("validate", 1)], turnsAtMs: 50 * MIN });

    const out = await h.ciWait();

    expect(out.result.verdict).toBe("red");
  });

  it("still times out at the plain timeout when a required check never reported", async () => {
    const h = harness([]);

    const out = await h.ciWait();

    expect(out.error).toContain("timed out after 2700000 ms");
    expect(h.clock.now).toBeLessThan(TIMEOUT_MS + POLL_MS);
  });

  it("decides identically on a second run over the same clock and inputs", async () => {
    const first = await harness([running("validate", 1, "queued")], { after: [successRun("validate", 1)], turnsAtMs: 50 * MIN }).ciWait();
    const second = await harness([running("validate", 1, "queued")], { after: [successRun("validate", 1)], turnsAtMs: 50 * MIN }).ciWait();

    expect(second.output).toBe(first.output);
  });
});
