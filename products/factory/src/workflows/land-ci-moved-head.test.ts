import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { ciWaitHead } from "./ci-wait-head.js";
import { landRoutes } from "./land.js";
import { REPO } from "../test-support/land.js";

const MIN = 60_000;
const OLD = fakeSha("old-head");
const NEW = fakeSha("new-head");
const running = (name: string, id: number): CheckRun => ({ ...successRun(name, id), status: "in_progress", conclusion: null });

/** A PR whose head is pushed past `OLD` at `pushAtMs` on the fake clock, as a merge train pushes while fixer wakes are stopped. */
function harness(newRuns: CheckRun[], pushAtMs: number) {
  const fake = fakeGitHub();
  fake.rules = { contexts: ["validate"], strict: false };
  fake.addPr({ headSha: OLD, mergeableState: "clean" });
  fake.setRuns(OLD, [running("validate", 1)]);
  const clock = { now: 0 };
  const seen: (string | undefined)[] = [];
  const route = landRoutes({
    port: githubPort(fake.wire),
    now: () => clock.now,
    sleep: async (ms) => {
      seen.push(ciWaitHead(REPO, 1));
      clock.now += ms;
      if (clock.now >= pushAtMs && fake.pr(1).headSha === OLD) {
        fake.setRuns(NEW, newRuns);
        fake.pushHead(1, NEW);
      }
    },
    pollMs: 30_000,
    ciTimeoutMs: 45 * MIN,
  }).find((candidate) => candidate.match === "ci-wait")!;
  const prompt = JSON.stringify({ repo: REPO, pr: 1, contexts: ["validate"], strict: false });
  const ciWait = async () => {
    const out = (await route.runner.run({ runId: "r", workflowName: "w", stepId: "ci-wait:r5", iteration: 0, prompt, signal: new AbortController().signal, attempt: 1, requestKey: "k" })) as { ok: boolean; output?: string };
    return { ...out, result: out.output ? JSON.parse(out.output).result : undefined };
  };
  return { ciWait, seen };
}

describe("ci-wait on a PR whose head moved while the wait ran (TP-4092)", () => {
  it("judges the pushed head, not the head the wait began on", async () => {
    const h = harness([successRun("validate", 2)], 5 * MIN);

    const out = await h.ciWait();

    expect(out.result).toMatchObject({ verdict: "green", headSha: NEW });
  });

  it("names the pushed head as the one it waits on while the new head's CI still runs", async () => {
    const h = harness([running("validate", 2)], 5 * MIN);

    await h.ciWait();

    expect(h.seen[0]).toBe(OLD);
    expect(h.seen.at(-1)).toBe(NEW);
    expect(ciWaitHead(REPO, 1)).toBeUndefined();
  });
});
