import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { NoVerdictCause, ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";
import { watchRow } from "./view.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = { sourceId: "transcript-1" } as unknown as SourceTextLocator;

/** H1 says `atH1` and every later head says MERGE; the `atH1` a host is built with stands in for the code it was deployed with. */
function phases(atH1: () => NoVerdictCause): ShepherdPhases {
  return {
    wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
    review: async (ctx, request) =>
      request.headSha === H1
        ? { kind: "none", cause: atH1() }
        : mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: [] }),
  };
}

/** H1 is behind its base; update-branch makes H2, which is H1 plus a merge of main and reads clean. */
function behindPr(): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge"), mergeableState: "behind", behind: true });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  fake.onGetPr = (pr) => {
    fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    if (pr.headSha !== H1) pr.mergeableState = "clean";
  };
  return fake;
}

function host(fake: FakeGitHub, store: ShepherdStoreRef, dbPath: string, atH1: () => NoVerdictCause): FactoryHost {
  let clock = 0;
  const base = githubPort(fake.wire);
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, [successRun("validate", 9)]), base.checkRuns(repo, sha)) };
  const routes = factoryRoutesFor({ port, store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
  const opened = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow(phases(atH1))], routes, gatePollMs: 5 });
  hosts.push(opened);
  return opened;
}

const stepsAt = (h: FactoryHost, runId: string, head: string): string[] => Object.keys(h.runtime.status(runId)!.stepResults).filter((key) => key.includes(head));

describe("a shepherd-pr run restarted on code whose route table changed", () => {
  it("resumes at the head it moved to, and runs no review or publish step at the head it left", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp1831-")), "factory.db");
    const fake = behindPr();
    const store = shepherdStoreRef();
    const first = host(fake, store, dbPath, () => "no-verdict");
    const runId = first.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    await gateOpened(first, gateId(runId, "approve-merge"));
    const h2 = fake.pr(1).headSha;
    const atH1 = stepsAt(first, runId, H1);
    first.close();

    // Redeployed, a review at a behind head that never started is asked again rather than updated past.
    const second = host(fake, store, dbPath, () => "not-started");
    await second.adopt();
    second.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: h2 }, OWNER);
    await second.runtime.wait(runId);

    expect(h2).not.toBe(H1);
    expect(atH1).toContain(`sh-publish-review:${H1}:0`);
    expect(stepsAt(second, runId, H1)).toEqual(atH1);
    expect(fake.effects.updateBranch).toBe(1);
    expect(fake.effects.merge).toBe(1);
    expect(watchRow({ registration: store.get().byRun(runId)!, run: second.runtime.status(runId)! }).headSha).toBe(h2);
  });
});
