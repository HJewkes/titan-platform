import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ShepherdPhases, Verdict, WakeRequest } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef } from "./store.js";
import { describeWake } from "./wake-brief.js";

/** Synthetic heads: a MERGE at A whose attestation row is unmet, the implementer's push to B, a MERGE at B. */
const A = fakeSha("attest-back-a");
const B = fakeSha("attest-back-b");
const unmetMerge = (headSha: string, why: string): Verdict => ({ kind: "MERGE", headSha, evidence: { attest: { unmet: [{ step: "ci-wait", why }] } } });
const cleanMerge = (headSha: string): Verdict => ({ kind: "MERGE", headSha, evidence: {} });

const SCRATCH = mkdtempSync(join(tmpdir(), "tp5689-attest-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A run whose reviewer answers each head as `reviewAt` says and whose implementer pushes B when woken at A. */
async function run(name: string, reviewAt: (head: string) => Verdict) {
  const fake: FakeGitHub = fakeGitHub();
  fake.addPr({ headSha: A });
  const wakes: WakeRequest[] = [];
  const phases: ShepherdPhases = {
    review: async (_ctx, request) => reviewAt(request.headSha),
    wake: async (_ctx, request) => {
      wakes.push(request);
      if (fake.pr(1).headSha === A) fake.pushHead(1, B);
      return { kind: "woken", agent: "impl-a" };
    },
  };
  fake.onGetPr = (open) => fake.setRuns(open.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const host = openFactoryHost({ dbPath: join(SCRATCH, `${name}.db`), workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  await gateOpened(host, gateId(runId, "approve-merge"));
  const approveHead = String(host.gates.get(gateId(runId, "approve-merge"))?.prompt.match(/head ([0-9a-f]{40})/)?.[1]);
  return { fake, wakes, approveHead };
}

describe("a reviewer's declined attestation", () => {
  it("attest-unmet with only no-meeter rows sends back to the implementer with the bump instruction", async () => {
    const { fake, wakes, approveHead } = await run("no-meeter", (head) => (head === A ? unmetMerge(A, "no-meeter") : cleanMerge(head)));

    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ kind: "review", headSha: A });
    const brief = await describeWake(githubPort(fake.wire), { kind: "review", repo: REPO, pr: 1, headSha: A, payload: wakes[0]!.payload }, fake.pr(1));
    expect(brief.reason).toContain("did not attest that ci-wait");
    expect(brief.reason).toContain("bump each step's version");
    expect(brief.reason).toContain("attestations/1.json");
    expect(approveHead).toBe(B);
  });

  it("attest-unmet meeter-is-author still raises approve-merge", async () => {
    const { wakes, approveHead } = await run("meeter-is-author", (head) => unmetMerge(head, "meeter-is-author"));

    expect(wakes).toEqual([]);
    expect(approveHead).toBe(A);
  });

  it("a send-back past the cap raises approve-merge", async () => {
    const { wakes, approveHead } = await run("past-cap", (head) => unmetMerge(head, "no-meeter"));

    expect(wakes.map((wake) => wake.headSha)).toEqual([A]);
    expect(approveHead).toBe(B);
  });
});
