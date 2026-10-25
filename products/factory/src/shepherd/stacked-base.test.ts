import { formatResultLine, type FixProofResult } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { FIX_PROOF_CHECK } from "./fix-proof.js";
import { MERGE_EVIDENCE_STEP } from "./merge-facts.js";
import { REBOUND_PROOF_STEP } from "./rebound-proof.js";
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
const phasesFor = (afterReview: () => void, proofUnverified?: string): ShepherdPhases => ({
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
  review: async (ctx, request: ReviewRequest) => {
    const proof = proofUnverified === undefined ? {} : { proofUnverified };
    const verdict = await mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"], ...proof });
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
  /** fix-proof judge runs at H1, served beside the required checks on every read. */
  proofRuns: CheckRun[];
  serveRuns: () => void;
}

/** Every merge-evidence read sees the PR on `base`, standing in for GitHub retargeting it there and back during each read. */
function evidenceReadOn(fake: FakeGitHub, base: string): (route: StepRoute) => StepRoute {
  let reading = false;
  const getPr = fake.wire.getPr;
  fake.wire.getPr = async (...args) => {
    const pr = await getPr(...args);
    return reading ? { ...pr, baseRef: base } : pr;
  };
  const during = (route: StepRoute): StepRoute => ({
    ...route,
    runner: {
      run: async (input) => {
        reading = true;
        try {
          return await route.runner.run(input);
        } finally {
          reading = false;
        }
      },
    },
  });
  return (route) => (route.match === MERGE_EVIDENCE_STEP ? during(route) : route);
}

/** A PR on `base`, reviewed MERGE at H1, whose checks are green; the stacked parent branch protects nothing, main requires `validate`. */
function world(base: string, policy: EffectivePolicy, afterReview: (fake: FakeGitHub) => void = () => undefined, evidenceBase?: string, proofUnverified?: string): World {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, baseRef: base, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const proofRuns: CheckRun[] = [];
  const serveRuns = () => fake.setRuns(H1, [successRun("validate", 1), successRun("dag-check", 2), ...proofRuns]);
  fake.onGetPr = (pr) => {
    serveRuns();
    fake.rules.contexts = pr.baseRef === "main" ? ["validate"] : [];
  };
  const mergedInto: string[] = [];
  const merge = fake.wire.merge;
  fake.wire.merge = async (...args) => (mergedInto.push(fake.pr(1).baseRef), merge(...args));
  const store = shepherdStoreRef();
  let clock = 0;
  const wrap = evidenceBase === undefined ? (route: StepRoute) => route : evidenceReadOn(fake, evidenceBase);
  const given = factoryRoutesFor({
    port: githubPort(fake.wire),
    store,
    now: () => clock,
    sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)),
    park: async () => ({ lines: [] }),
    registry: async () => "trusted" as const,
    mergeTree: async () => "clean",
  });
  const routes = Object.assign(given.map(wrap), { database: given.database, shepherd: given.shepherd });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phasesFor(() => afterReview(fake), proofUnverified))], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(policy) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy });
  return { fake, host, runId, mergedInto, proofRuns, serveRuns };
}

const REFUSAL = `fix-proof runs only against the default branch: base ${PARENT} is not main`;
const REFUSED_JOB = 70;
const MAIN_JOB = 71;

function proofLine(verdict: FixProofResult["verdict"], error?: string): string {
  const counts = { reproduces: verdict === "reproduced" ? 1 : 0, "passes-on-base": 0, "new-api": 0, "fails-on-head": 0, "not-run": 0 };
  return formatResultLine({ head: H1, mergeBase: fakeSha("stack-merge-base"), verdict, counts, notCollected: [], deletedTests: [], configEdited: false, tests: [], truncated: false, ...(error !== undefined && { error }) });
}

/** A judge run at H1 that printed `line`; GitHub lists the PR on its live base, so even the refused run reads as on main. */
function judged({ fake, proofRuns, serveRuns }: World, id: number, line: string): void {
  proofRuns.push({ ...successRun(FIX_PROOF_CHECK, id), headSha: H1, pullRequests: [{ number: 1, baseRef: "main" }] });
  fake.jobLogs.set(id, line);
  serveRuns();
}

const reboundReads = (w: World) => Object.values(w.host.runtime.status(w.runId)!.stepResults).filter((result) => result.stepId.startsWith(`${REBOUND_PROOF_STEP}:`));

const stepIds = ({ host, runId }: World): string[] => Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
const mergePolicies = (w: World) => Object.values(w.host.runtime.status(w.runId)!.stepResults).filter((result) => result.stepId.startsWith("merge-policy"));
const pendingGate = ({ host, runId }: World) => host.pendingGates().find((pending) => pending.runId === runId && pending.stepId.startsWith("approve-merge"));

async function waitingForRetarget({ host, runId }: World): Promise<void> {
  await vi.waitFor(() => expect(host.runtime.status(runId)?.currentStep).toMatch(/^base-wait/), { interval: 5 });
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
    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true));

    expect(w.mergedInto).toEqual(["main"]);
    expect(pendingGate(w)).toBeUndefined();
    expect(stepIds(w).filter((id) => id === `${MERGE_EVIDENCE_STEP}:${H1}`)).toHaveLength(2);
    const decided = mergePolicies(w);
    expect(decided).toHaveLength(1);
    expect(decided[0]!.data).toMatchObject({ result: { outcome: "allow", headSha: H1, rule: { table: "authority", rowId: "MRG-AU-RV" } } });
  });

  it("re-reads evidence taken on the parent branch when GitHub retargets before land looks, so it never decides on the stale record", async () => {
    const w = world(PARENT, AUTO, (fake) => (fake.pr(1).baseRef = "main"));

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true));

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

describe("a stacked PR whose fix-proof was refused on the parent branch, retargeted to main with the same head (TP-4259)", () => {
  const refused = (policy: EffectivePolicy = AUTO): World => {
    const w = world(PARENT, policy, undefined, undefined, `error (${REFUSAL})`);
    judged(w, REFUSED_JOB, proofLine("error", REFUSAL));
    return w;
  };

  it("merges nothing into main on the panel's MERGE until a main-bound fix-proof line at the head is read", async () => {
    const w = refused();
    let mergesAtRefusedRead: number | undefined;
    const getJobLog = w.fake.wire.getJobLog;
    w.fake.wire.getJobLog = async (repo, jobId) => {
      if (jobId === REFUSED_JOB && mergesAtRefusedRead === undefined) {
        mergesAtRefusedRead = w.fake.effects.merge;
        judged(w, MAIN_JOB, proofLine("reproduced"));
      }
      return getJobLog(repo, jobId);
    };
    await waitingForRetarget(w);

    w.fake.pr(1).baseRef = "main";
    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true));

    expect(mergesAtRefusedRead).toBe(0);
    expect(w.mergedInto).toEqual(["main"]);
    expect(reboundReads(w).map((read) => read.data)).toMatchObject([{ result: { bound: true, line: proofLine("reproduced") } }]);
  });

  it("asks the owner instead of merging when only the refused line stands at the head", async () => {
    const w = refused();
    await waitingForRetarget(w);

    w.fake.pr(1).baseRef = "main";
    await gateOpened(w.host, gateId(w.runId, "approve-merge"));

    expect(w.fake.effects.merge).toBe(0);
    expect(w.host.gates.get(gateId(w.runId, "approve-merge"))?.prompt).toContain("no fix-proof line against main has been read at this head");
    const reads = reboundReads(w);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((read) => (read.data as { result?: { bound?: boolean } }).result?.bound === false)).toBe(true);
  });

  it("reads nothing again on a seat that decides on the parent branch the proof was refused on", async () => {
    const w = refused({ ...AUTO, featureBase: true });

    await vi.waitFor(() => expect(mergePolicies(w).length).toBeGreaterThan(0));

    expect(reboundReads(w)).toEqual([]);
    expect(JSON.stringify(mergePolicies(w)[0]!.data)).not.toContain("no fix-proof line against");
  });
});

describe("a PR on main whose merge evidence was read while it pointed at the parent branch", () => {
  it("gates instead of allowing MRG-AU-RV on the parent's facts, and merges nothing", async () => {
    const w = world("main", AUTO, undefined, PARENT);

    await gateOpened(w.host, gateId(w.runId, "approve-merge"));

    expect(w.fake.effects.merge).toBe(0);
    expect(mergePolicies(w).at(-1)!.data).toMatchObject({ result: { outcome: "gate", headSha: H1, rule: { table: "shepherd-merge-guard", rowId: "no-facts" } } });
    expect(w.host.gates.get(gateId(w.runId, "approve-merge"))?.prompt).toContain(`read on base ${PARENT}, not on main`);
  });
});

describe("a stacked PR on a seat that grants merge-into-feature-base", () => {
  it("keeps today's path: it never waits at base-wait and decides on the stacked base", async () => {
    const w = world(PARENT, { ...AUTO, featureBase: true });

    await vi.waitFor(() => expect(mergePolicies(w).length).toBeGreaterThan(0));

    expect(stepIds(w).filter((id) => id.startsWith("base-wait"))).toEqual([]);
    expect(stepIds(w).filter((id) => id === `${MERGE_EVIDENCE_STEP}:${H1}`)).toHaveLength(1);
  });
});
