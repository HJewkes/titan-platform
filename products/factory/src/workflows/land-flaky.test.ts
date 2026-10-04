import { fakeGitHub, githubPort, successRun, type CheckRun, type FakeGitHub } from "@titan-design/github";
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

/** One PR at H1 whose two required checks follow `runs`, given how many reruns GitHub has been asked for. */
function world(runs: (reruns: number) => CheckRun[], flakyChecks?: Record<string, FlakyChecks>): World {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, runs(fake.effects.rerunFailedJobs));
  const sleeps: number[] = [];
  const routes = landPrRoutes({ port: githubPort(fake.wire), now: () => 0, sleep: async (ms) => void sleeps.push(ms), flakyChecks });
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
});
