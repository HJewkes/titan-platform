import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ShepherdPhases, Verdict, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";
import { awaitFixerHead } from "./wake.js";

const H2 = fakeSha("head2");
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** `validate` is red until the fixer acts; the fixer's action and the real post-wake wait stand in for the wake phase. */
function scenario(fix: (fake: FakeGitHub, request: WakeRequest) => void, review: (headSha: string) => Verdict = () => ({ kind: "none" })) {
  const fake = fakeGitHub();
  let fixed = false;
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, fixed ? "success" : "failure"), successRun("dag-check", 2)]);
  const wakes: WakeRequest[] = [];
  const phases: ShepherdPhases = {
    wake: async (ctx, request) => (wakes.push(request), (fixed = true), fix(fake, request), awaitFixerHead(ctx, request, { agent: "impl-a" })),
    review: async (_ctx, request) => review(request.headSha),
  };
  let clock = 0;
  const store = shepherdStoreRef();
  const tick = async (ms: number, signal: AbortSignal) => ((clock += ms), sleep(1, signal));
  const port = githubPort(fake.wire);
  const mainGreen = { ...port, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, [successRun("validate", 9), successRun("dag-check", 10)]), port.checkRuns(repo, sha)) };
  const routes = factoryRoutesFor({ port: mainGreen, store, now: () => clock, sleep: tick });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1 });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return { fake, host, runId, wakes };
}

function result(host: FactoryHost, runId: string, stepId: string): unknown {
  return Object.values(host.runtime.status(runId)!.stepResults).find((step) => step.stepId === stepId)?.data;
}

async function approveAt(host: FactoryHost, runId: string, headSha: string): Promise<void> {
  await gateOpened(host, gateId(runId, "approve-merge"));
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha }, OWNER);
  await host.runtime.wait(runId);
}

describe("a ci-red wake the fixer answers with a rerun", () => {
  it("leaves sh-await-new-head when the same head turns green and merges that head with no new commit", async () => {
    const { fake, host, runId, wakes } = scenario(() => undefined);

    await approveAt(host, runId, H1);

    expect(wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1]]);
    expect(result(host, runId, "sh-await-new-head:0")).toMatchObject({ result: { headSha: H1, green: true } });
    expect(result(host, runId, "ci-wait:r1:0")).toMatchObject({ result: { headSha: H1, verdict: "green" } });
    expect(fake.effects.merge).toBe(1);
  });

  it("still wakes the fixer for a FIX_FIRST review at the head the rerun turned green", async () => {
    const pushOnReview = (github: FakeGitHub, request: WakeRequest) => void (request.kind === "review" && github.pushHead(1, H2));
    const fixFirstAtH1 = (headSha: string): Verdict => (headSha === H1 ? { kind: "FIX_FIRST", headSha: H1, text: "missing test" } : { kind: "none" });
    const { fake, host, runId, wakes } = scenario(pushOnReview, fixFirstAtH1);

    await approveAt(host, runId, H2);

    expect(wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1], ["review", H1]]);
    expect(fake.effects.merge).toBe(1);
  });

  it("still lands the new head when the fixer pushes one instead", async () => {
    const { fake, host, runId } = scenario((github) => github.pushHead(1, H2));

    await approveAt(host, runId, H2);

    expect(result(host, runId, "sh-await-new-head:0")).toMatchObject({ result: { headSha: H2 } });
    expect(result(host, runId, "ci-wait:r1:0")).toMatchObject({ result: { headSha: H2, verdict: "green" } });
    expect(fake.effects.merge).toBe(1);
  });
});
