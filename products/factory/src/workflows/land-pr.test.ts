import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { landPrRoutes, landPrWorkflow } from "./land-pr.js";

const H2 = fakeSha("head2");
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** The required `validate` run a head shows, given how many reruns this run has asked GitHub for. */
type Validate = (headSha: string, reruns: number) => CheckRun;

const passing: Validate = () => successRun("validate", 1);
const run = (id: number, conclusion: string): CheckRun => successRun("validate", id, undefined, conclusion);

/** One PR at H1 whose `validate` check follows `validate`, and a factory host running the registered land-pr workflow. */
function landPrWorld(validate: Validate): { host: FactoryHost; fake: FakeGitHub; runId: string } {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [validate(pr.headSha, fake.effects.rerunFailedJobs), successRun("dag-check", 2)]);
  let clock = 0;
  const routes = landPrRoutes({ port: githubPort(fake.wire), now: () => clock, sleep: async (ms) => void (clock += ms) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, runId: host.runtime.start("land-pr", { repo: REPO, pr: "1", task: "TASK-1" }) };
}

function stepIds(host: FactoryHost, runId: string): string[] {
  return Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
}

async function approveAndFinish(host: FactoryHost, runId: string, headSha: string, iteration = 0): Promise<void> {
  await gateOpened(host, gateId(runId, "approve-merge", iteration));
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha });
  await host.runtime.wait(runId);
}

describe("land-pr", () => {
  it("reruns one cancelled check exactly once, then merges the green head after approval", async () => {
    const { host, fake, runId } = landPrWorld((_sha, reruns) => (reruns === 0 ? run(1, "cancelled") : run(3, "success")));

    await approveAndFinish(host, runId, H1);

    expect(host.runtime.status(runId)?.status).toBe("completed");
    expect(fake.effects).toMatchObject({ rerunFailedJobs: 1, merge: 1 });
    expect(host.gates.get(gateId(runId, "ci-failed"))).toBeUndefined();
    expect(stepIds(host, runId)).toEqual(["snapshot", "land-rules", "ci-wait:0", "rerun:0", "land-rules:r1", "ci-wait:r1:0", "merge-policy:r1:0", "approve-merge", "ci-wait:r1:1", "merge:r1:0", "post-merge"]);
  });

  it("opens ci-failed instead of a second rerun when the rerun is cancelled again", async () => {
    const { host, fake, runId } = landPrWorld((_sha, reruns) => (reruns < 2 ? run(1 + 2 * reruns, "cancelled") : run(5, "success")));

    await gateOpened(host, gateId(runId, "ci-failed"));
    const rerunsBeforeAnswer = fake.effects.rerunFailedJobs;
    host.runtime.signal(runId, "ci-failed", { decision: "rerun", headSha: H1 });
    await approveAndFinish(host, runId, H1);

    expect(rerunsBeforeAnswer).toBe(1);
    expect(fake.effects).toMatchObject({ rerunFailedJobs: 2, merge: 1 });
    expect(stepIds(host, runId)).toEqual(expect.arrayContaining(["rerun:0", "ci-failed", "rerun:1", "merge:r2:0"]));
  });

  it("on await-fix, waits through unchanged heads until someone pushes a new one, then lands it", async () => {
    let awaiting = false;
    let polls = 0;
    const { host, fake, runId } = landPrWorld((sha) => (sha === H1 ? run(1, "failure") : run(3, "success")));
    const green = fake.onGetPr!;
    fake.onGetPr = (pr, reads) => (awaiting && ++polls === 4 && (pr.headSha = H2), green(pr, reads));

    await gateOpened(host, gateId(runId, "ci-failed"));
    expect(host.gates.get(gateId(runId, "ci-failed"))?.prompt).toContain(`validate (failure) ${run(1, "failure").url}`);
    awaiting = true;
    host.runtime.signal(runId, "ci-failed", { decision: "await-fix", headSha: H1 });
    await approveAndFinish(host, runId, H2);

    expect(polls).toBeGreaterThanOrEqual(4);
    expect(host.runtime.status(runId)!.stepResults["await-new-head:0:0"]!.data).toMatchObject({ result: { headSha: H2 } });
    expect(host.gates.get(gateId(runId, "ci-failed", 1))).toBeUndefined();
    expect(fake.effects).toMatchObject({ rerunFailedJobs: 0, merge: 1 });
    expect(fake.pr(1).merged).toBe(true);
  });

  it("asks again when a commit this run did not make moves the head after approval", async () => {
    let approved = false;
    const { host, fake, runId } = landPrWorld(passing);
    const green = fake.onGetPr!;
    fake.onGetPr = (pr, reads) => (approved && pr.headSha === H1 && (pr.headSha = H2), green(pr, reads));
    await gateOpened(host, gateId(runId, "approve-merge"));

    approved = true;
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 });
    await gateOpened(host, gateId(runId, "approve-merge", 1));
    const mergesBeforeSecondApproval = fake.effects.merge;
    const reuseOldApproval = () => host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 });

    expect(reuseOldApproval).toThrow(`headSha: expected "${H2}"`);
    expect(host.gates.get(gateId(runId, "approve-merge", 1))?.prompt).toContain(H2);
    await approveAndFinish(host, runId, H2, 1);
    expect(mergesBeforeSecondApproval).toBe(0);
    expect(fake.pr(1)).toMatchObject({ merged: true, headSha: H2 });
  });

  it("refuses a ci-failed answer that names a stale head, then stops on abandon without rerunning or merging", async () => {
    const { host, fake, runId } = landPrWorld(() => run(1, "failure"));
    await gateOpened(host, gateId(runId, "ci-failed"));

    const staleAnswer = () => host.runtime.signal(runId, "ci-failed", { decision: "rerun", headSha: H2 });

    expect(staleAnswer).toThrow(`headSha: expected "${H1}"`);
    expect(host.gates.get(gateId(runId, "ci-failed"))?.status).toBe("pending");
    host.runtime.signal(runId, "ci-failed", { decision: "abandon", headSha: H1 });
    expect((await host.runtime.wait(runId)).status).toBe("completed");
    expect(fake.effects).toMatchObject({ rerunFailedJobs: 0, merge: 0 });
  });

  it("records the pull request, its required checks and the task link in the snapshot step", async () => {
    const { host, runId } = landPrWorld(passing);

    await approveAndFinish(host, runId, H1);

    expect(host.runtime.status(runId)!.stepResults["snapshot:0"]!.data).toMatchObject({
      result: { pr: { number: 1, headSha: H1, baseRef: "main" }, required: ["validate", "dag-check"], task: "TASK-1" },
    });
  });

  it("fails the run before any step when pr is not a positive integer", async () => {
    const fake = fakeGitHub();
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [landPrWorkflow()], routes: landPrRoutes({ port: githubPort(fake.wire) }) });
    hosts.push(host);

    const failed = await host.runtime.wait(host.runtime.start("land-pr", { repo: REPO, pr: "1.5" }));

    expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining("pr must be a positive integer, got 1.5") });
    expect(fake.calls).toEqual([]);
  });
});
