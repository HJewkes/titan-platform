import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { MERGE_EVIDENCE_STEP } from "./merge-facts.js";
import type { ReviewRequest, ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef } from "./store.js";

const PARENT = "agent-chat/parent";
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = partialFake<SourceTextLocator>({ selector: partialFake<SourceTextLocator["selector"]>({ kind: "subrecord-text" }) });

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** `afterReview` runs once the MERGE verdict and its evidence are recorded, standing in for GitHub retargeting the PR then. */
const phasesFor = (afterReview: () => void): ShepherdPhases => ({
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
  review: async (ctx, request: ReviewRequest) => {
    const verdict = await mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] });
    afterReview();
    return verdict;
  },
});

interface World {
  fake: FakeGitHub;
  host: FactoryHost;
  runId: string;
  /** The base of the PR at each merge the fake took. */
  mergedInto: string[];
}

/** A PR on `base`, reviewed MERGE at H1, whose checks are green; the stacked parent branch protects nothing, main requires `validate`. */
function world(base: string, policy: EffectivePolicy, afterReview: (fake: FakeGitHub) => void = () => undefined): World {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, baseRef: base, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  fake.onGetPr = (pr) => {
    fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    fake.rules.contexts = pr.baseRef === "main" ? ["validate"] : [];
  };
  const mergedInto: string[] = [];
  const merge = fake.wire.merge;
  fake.wire.merge = async (...args) => (mergedInto.push(fake.pr(1).baseRef), merge(...args));
  const store = shepherdStoreRef();
  let clock = 0;
  const routes = factoryRoutesFor({
    port: githubPort(fake.wire),
    store,
    now: () => clock,
    sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)),
    park: async () => ({ lines: [] }),
    registry: async () => "trusted" as const,
    mergeTree: async () => "clean",
  });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phasesFor(() => afterReview(fake)))], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(policy) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy });
  return { fake, host, runId, mergedInto };
}

const stepIds = ({ host, runId }: World): string[] => Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
const mergePolicies = (w: World) => Object.values(w.host.runtime.status(w.runId)!.stepResults).filter((result) => result.stepId.startsWith("merge-policy"));
const pendingGate = ({ host, runId }: World) => host.pendingGates().find((pending) => pending.runId === runId && pending.stepId.startsWith("approve-merge"));

async function waitingForRetarget({ host, runId }: World): Promise<void> {
  await vi.waitFor(() => expect(host.runtime.status(runId)?.currentStep).toMatch(/^base-wait/), { timeout: 10_000, interval: 5 });
}

describe("a stacked PR whose MERGE evidence was read on the parent branch", () => {
  it("waits with no gate and no merge while the base is not main, then merges under MRG-AU once GitHub retargets it", async () => {
    const w = world(PARENT, AUTO);

    await waitingForRetarget(w);

    expect(pendingGate(w)).toBeUndefined();
    expect(w.host.gates.get(gateId(w.runId, "approve-merge"))).toBeUndefined();
    expect(mergePolicies(w)).toEqual([]);
    expect(w.fake.effects.merge).toBe(0);
    expect(w.fake.pr(1).merged).toBe(false);

    w.fake.pr(1).baseRef = "main";
    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 10_000 });

    expect(w.mergedInto).toEqual(["main"]);
    expect(pendingGate(w)).toBeUndefined();
    expect(stepIds(w).filter((id) => id === `${MERGE_EVIDENCE_STEP}:${H1}`)).toHaveLength(2);
    const decided = mergePolicies(w);
    expect(decided).toHaveLength(1);
    expect(decided[0]!.data).toMatchObject({ result: { outcome: "allow", headSha: H1, rule: { table: "authority", rowId: "MRG-AU-RV" } } });
  });

  it("re-reads evidence taken on the parent branch when GitHub retargets before land looks, so it never decides on the stale record", async () => {
    const w = world(PARENT, AUTO, (fake) => (fake.pr(1).baseRef = "main"));

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 10_000 });

    const reads = Object.values(w.host.runtime.status(w.runId)!.stepResults).filter((result) => result.stepId === `${MERGE_EVIDENCE_STEP}:${H1}`);
    expect(reads).toHaveLength(2);
    expect(reads[0]!.data).toMatchObject({ result: { record: { baseRef: PARENT } } });
    expect(reads[1]!.data).toMatchObject({ result: { record: { baseRef: "main" } } });
    expect(stepIds(w).filter((id) => id.startsWith("base-wait"))).toEqual([]);
    expect(w.mergedInto).toEqual(["main"]);
    expect(pendingGate(w)).toBeUndefined();
    expect(mergePolicies(w)[0]!.data).toMatchObject({ result: { outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RV" } } });
  });

  it("opens no gate for a PR that stays on the parent branch, and merges nothing", async () => {
    const w = world(PARENT, AUTO);

    await waitingForRetarget(w);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(pendingGate(w)).toBeUndefined();
    expect(w.fake.effects.merge).toBe(0);
    expect(w.mergedInto).toEqual([]);
  });
});

describe("a stacked PR on a seat that grants merge-into-feature-base", () => {
  it("keeps today's path: it never waits at base-wait and decides on the stacked base", async () => {
    const w = world(PARENT, { ...AUTO, featureBase: true });

    await vi.waitFor(() => expect(mergePolicies(w).length).toBeGreaterThan(0), { timeout: 10_000 });

    expect(stepIds(w).filter((id) => id.startsWith("base-wait"))).toEqual([]);
    expect(stepIds(w).filter((id) => id === `${MERGE_EVIDENCE_STEP}:${H1}`)).toHaveLength(1);
  });
});
