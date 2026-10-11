import { fakeGitHub, githubPort, successRun, type CheckRun, type GitHubPort } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { H1, REPO } from "../test-support/land.js";
import type { FlakyChecks } from "./land-flaky.js";
import { landRoutes } from "./land.js";

const WAIT_SECONDS = 90;
const LIST: FlakyChecks = { checks: ["validate", "lint"], waitSeconds: WAIT_SECONDS };

const run = (name: string, id: number, conclusion: string): CheckRun => successRun(name, id, undefined, conclusion);

interface Options {
  runs: (reruns: number) => CheckRun[];
  ciTimeoutMs?: number;
  port?: (port: GitHubPort, clock: { now: number }) => GitHubPort;
}

/** ci-wait over a PR at H1 whose required checks follow `runs`, given how many reruns GitHub has been asked for; the clock moves only by sleeping. */
function ciWait(options: Options) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, options.runs(fake.effects.rerunFailedJobs));
  const clock = { now: 0 };
  const sleeps: number[] = [];
  const port = githubPort(fake.wire);
  const routes = landRoutes({
    port: options.port?.(port, clock) ?? port,
    now: () => clock.now,
    sleep: async (ms) => { clock.now += ms; sleeps.push(ms); },
    flakyChecks: { [REPO.toLowerCase()]: LIST },
    ciTimeoutMs: options.ciTimeoutMs,
  });
  const route = routes.find((candidate) => candidate.match === "ci-wait")!;
  const prompt = JSON.stringify({ repo: REPO, pr: 1, contexts: ["validate", "lint"], strict: false });
  const result = () => route.runner.run({ runId: "r", workflowName: "w", stepId: "ci-wait", iteration: 0, prompt, signal: new AbortController().signal, attempt: 1, requestKey: "k" }) as Promise<{ ok: boolean; error?: string; output?: string }>;
  return { fake, sleeps, result };
}

describe("ci-wait after a flaky check rerun", () => {
  it("times out when the rerun outlasts the land deadline, not on a fresh read", async () => {
    const { result, fake } = ciWait({ runs: (reruns) => [run("validate", 1 + 2 * reruns, "failure"), run("lint", 100, "success")], ciTimeoutMs: 60_000 });

    const outcome = await result();

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/timed out/);
    expect(fake.effects.rerunFailedJobs).toBe(1);
  });

  it("reports a red whose check-run read failed with the time it was read, not the wait later", async () => {
    const { result } = ciWait({
      runs: () => [run("validate", 1, "failure"), run("lint", 100, "success")],
      port: (port, clock) => ({ ...port, checkRuns: async (repo, sha) => (clock.now > 0 ? Promise.reject(new Error("read failed")) : port.checkRuns(repo, sha)) }),
    });

    const outcome = await result();

    expect(JSON.parse(outcome.output!).result).toMatchObject({ verdict: "red", readAt: 0 });
  });

  it("does not wait out the settle for a run GitHub refused to rerun", async () => {
    const { result, sleeps } = ciWait({
      runs: (reruns) => [run("validate", 1 + 2 * reruns, "failure"), run("lint", 100, "failure")],
      port: (port) => ({ ...port, rerunFailed: async (repo, runId) => (runId === 1100 ? { done: false, skipped: "in-progress" } : port.rerunFailed(repo, runId)) }),
    });

    await result();

    expect(sleeps.filter((ms) => ms === 5_000)).toEqual([]);
  });
});
