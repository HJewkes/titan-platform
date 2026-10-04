import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import type { FlakyChecks } from "./land-flaky.js";
import { landPrRoutes, landPrWorkflow } from "./land-pr.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const run = (name: string, id: number, conclusion: string): CheckRun => successRun(name, id, undefined, conclusion);
const LIST: FlakyChecks = { checks: ["validate"], waitSeconds: 90 };

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  runId: string;
  sleeps: number[];
}

interface Hooks {
  onSleep?: (fake: FakeGitHub, ms: number) => void | Promise<void>;
  port?: (port: GitHubPort) => GitHubPort;
}

/** One PR at H1 whose two required checks follow `runs`, given how many reruns GitHub has been asked for. */
function world(runs: (reruns: number, headSha: string) => CheckRun[], flakyChecks?: Record<string, FlakyChecks>, hooks: Hooks = {}): World {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, runs(fake.effects.rerunFailedJobs, pr.headSha));
  const sleeps: number[] = [];
  const port = githubPort(fake.wire);
  const routes = landPrRoutes({ port: hooks.port?.(port) ?? port, now: () => 0, sleep: async (ms) => { sleeps.push(ms); await hooks.onSleep?.(fake, ms); }, flakyChecks });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, sleeps, runId: host.runtime.start("land-pr", { repo: REPO, pr: "1" }) };
}

const dagCheck = () => successRun("dag-check", 2);

describe("flaky check rerun", () => {
  it("an all-listed failure reruns once and wakes nobody", async () => {
    const { host, fake, runId, sleeps } = world((reruns) => [reruns === 0 ? run("validate", 1, "failure") : run("validate", 3, "success"), dagCheck()], { [REPO.toLowerCase()]: LIST });

    await gateOpened(host, gateId(runId, "approve-merge"));
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    await host.runtime.wait(runId);

    expect(fake.effects).toMatchObject({ rerunFailedJobs: 1, merge: 1 });
    expect(host.gates.get(gateId(runId, "ci-failed"))).toBeUndefined();
    expect(sleeps).toContain(90_000);
  });

  it("one unlisted failure wakes as today", async () => {
    const { host, fake, runId } = world(() => [run("validate", 1, "failure"), run("dag-check", 2, "failure")], { [REPO.toLowerCase()]: LIST });

    await gateOpened(host, gateId(runId, "ci-failed"));

    expect(fake.effects.rerunFailedJobs).toBe(0);
  });

  it("a second red after the flaky rerun wakes", async () => {
    const { host, fake, runId } = world((reruns) => [run("validate", 1 + 2 * reruns, "failure"), dagCheck()], { [REPO.toLowerCase()]: LIST });

    await gateOpened(host, gateId(runId, "ci-failed"));

    expect(fake.effects.rerunFailedJobs).toBe(1);
  });

  it("no config means today's behaviour", async () => {
    const { host, fake, runId } = world(() => [run("validate", 1, "failure"), dagCheck()]);

    await gateOpened(host, gateId(runId, "ci-failed"));

    expect(fake.effects.rerunFailedJobs).toBe(0);
  });

  it("a head pushed during the wait is not rerun and spends no budget", async () => {
    const H2 = fakeSha("head2");
    const { host, fake, runId } = world((_, sha) => [sha === H1 ? run("validate", 1, "failure") : run("validate", 5, "success"), dagCheck()], { [REPO.toLowerCase()]: LIST }, {
      onSleep: (f, ms) => (ms === 90_000 ? f.pushHead(1, H2) : undefined),
    });

    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(fake.effects.rerunFailedJobs).toBe(0);
    expect(host.gates.get(gateId(runId, "ci-failed"))).toBeUndefined();
  });

  it("a rerun GitHub refuses wakes without claiming a rerun", async () => {
    const { host, runId } = world(() => [run("validate", 1, "failure"), dagCheck()], { [REPO.toLowerCase()]: LIST }, {
      port: (port) => ({ ...port, rerunFailed: async () => ({ done: false, skipped: "in-progress" }) }),
    });

    await gateOpened(host, gateId(runId, "ci-failed"));
  });

  it("a run replaced during the wait is not rerun", async () => {
    const { host, fake, runId } = world((_, __) => [run("validate", 1, "failure"), dagCheck()], { [REPO.toLowerCase()]: LIST }, {
      onSleep: (f, ms) => {
        if (ms === 90_000) f.onGetPr = (pr) => f.setRuns(pr.headSha, [{ ...run("validate", 7, "success") }, dagCheck()]);
      },
    });

    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(fake.effects.rerunFailedJobs).toBe(0);
  });
});
