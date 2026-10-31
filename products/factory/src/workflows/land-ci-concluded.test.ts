import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import type { RoutedStepInput } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { landRoutes } from "./land.js";
import { REPO } from "../test-support/land.js";

const POLL_MS = 30_000;
const TIMEOUT_MS = 45 * 60_000;
const T0 = 1_800_000_000_000;
const HEAD = fakeSha("stuck-open-head");

const Outcome = z.object({ ok: z.boolean(), error: z.string().optional(), output: z.string().optional() });
const Output = z.object({ result: z.object({ verdict: z.string() }) });
/** GitHub sometimes leaves a job's status at in_progress after it has a conclusion and a completion time. */
const stuckOpen = (conclusion: string): CheckRun => ({ ...successRun("validate", 1), status: "in_progress", conclusion, completedAt: "2026-01-01T00:05:00Z" });

async function ciWait(run: CheckRun) {
  const fake = fakeGitHub();
  fake.rules = { contexts: ["validate"], strict: false };
  fake.addPr({ headSha: HEAD, mergeableState: "clean" });
  fake.setRuns(HEAD, [run]);
  const clock = { now: T0 };
  const route = landRoutes({ port: githubPort(fake.wire), now: () => clock.now, sleep: async (ms) => void (clock.now += ms), pollMs: POLL_MS, ciTimeoutMs: TIMEOUT_MS }).find((candidate) => candidate.match === "ci-wait");
  if (!route) throw new Error("no ci-wait route");
  const step: RoutedStepInput = { runId: "r", workflowName: "w", stepId: "ci-wait", iteration: 0, prompt: JSON.stringify({ repo: REPO, pr: 1, contexts: ["validate"], strict: false }), signal: new AbortController().signal, attempt: 0, requestKey: "k" };
  const outcome = Outcome.parse(await route.runner.run(step));
  const verdict = outcome.output === undefined ? undefined : Output.parse(JSON.parse(outcome.output)).result.verdict;
  return { ...outcome, verdict, elapsed: clock.now - T0 };
}

describe("ci-wait over a job whose status stayed in_progress after it concluded", () => {
  it("finishes green within one poll when the conclusion is success", async () => {
    const out = await ciWait(stuckOpen("success"));

    expect(out.verdict).toBe("green");
    expect(out.elapsed).toBeLessThanOrEqual(POLL_MS);
  });

  it("finishes red within one poll when the conclusion is failure", async () => {
    const out = await ciWait(stuckOpen("failure"));

    expect(out.verdict).toBe("red");
    expect(out.elapsed).toBeLessThanOrEqual(POLL_MS);
  });
});
