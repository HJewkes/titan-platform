import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ShepherdPhases, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { ESCALATIONS } from "./route-table.js";
import { shepherdStoreRef } from "./store.js";

const H2 = fakeSha("head2");
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A behind PR whose every update-branch conflicts, and a fixer that pushes H2 without settling the conflict. */
function conflictingWorld() {
  const fake = fakeGitHub();
  fake.updateBranchConflict = true;
  fake.addPr({ headSha: H1, mergeableState: "behind", behind: true });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const wakes: WakeRequest[] = [];
  const phases: ShepherdPhases = {
    wake: async (_ctx, request) => (wakes.push(request), fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" }),
    review: async () => ({ kind: "none" }),
  };
  const store = shepherdStoreRef();
  let clock = 0;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return { fake, host, runId, wakes };
}

describe("a merge conflict that survives one fixer attempt", () => {
  it("retries update-branch at the fixer's head, then opens the owner's conflict gate and wakes no second fixer", async () => {
    const { fake, host, runId, wakes } = conflictingWorld();

    await gateOpened(host, gateId(runId, "approve-merge"));
    const updatedHeads = Object.values(host.runtime.status(runId)!.stepResults)
      .filter((result) => result.stepId.startsWith("update-branch"))
      .map((result) => (result.data as { result: { headSha: string } }).result.headSha);
    host.runtime.signal(runId, "approve-merge", { decision: "abandon", headSha: H2 }, OWNER);
    await host.runtime.wait(runId);

    expect(wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["conflict", H1]]);
    expect(updatedHeads).toEqual([H1, H2]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(`Policy shepherd-route/conflict: ${ESCALATIONS.conflict}`);
    expect(fake.effects.merge).toBe(0);
  });
});
