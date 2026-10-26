import { formatResultLine, type FixProofResult } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { FIX_PROOF_CHECK, readFixProofAt } from "./fix-proof.js";
import { proofUnverifiedOf } from "./grant-withheld.js";
import { MERGE_EVIDENCE_STEP } from "./merge-facts.js";
import type { ReviewRequest, ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { proofStandingAt } from "./proof-waiver.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef } from "./store.js";

const PARENT = "agent-chat/parent";
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = partialFake<SourceTextLocator>({ selector: partialFake<SourceTextLocator["selector"]>({ kind: "subrecord-text" }) });

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/**
 * The review reads the head's fix-proof through the real sh-fix-proof step and records its standing on the MERGE, as the review
 * phase does. `afterReview` runs once the MERGE verdict and its evidence are recorded, standing in for GitHub retargeting the PR then.
 */
const phasesFor = (afterReview: () => void): ShepherdPhases => ({
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
  review: async (ctx, request: ReviewRequest) => {
    const gated = await proofStandingAt(ctx, request.headSha, await readFixProofAt(ctx, { repo: request.repo, head: request.headSha }));
    if ("ended" in gated) return gated.ended;
    const proofUnverified = proofUnverifiedOf(gated.standing);
    const proof = { ...(proofUnverified !== undefined && { proofUnverified }), ...(gated.standing.proofBase !== undefined && { proofBase: gated.standing.proofBase }) };
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
  /** Adds a completed fix-proof judge run at H1 that printed `line`; GitHub lists it on the PR's live base, whatever base it judged. */
  judged: (id: number, line: string, conclusion?: string) => void;
  /** While on, the PR cannot be read inside a fix-proof read on a decided base. */
  prUnreadable: { on: boolean };
}

/** While `failing.on`, a fix-proof read on a decided base cannot read the PR, as a GitHub 5xx during that read would leave it. */
function prUnreadableInBaseReads(fake: FakeGitHub, failing: { on: boolean }): (route: StepRoute) => StepRoute {
  let inBaseRead = false;
  const getPr = fake.wire.getPr;
  fake.wire.getPr = async (...args) => {
    if (failing.on && inBaseRead) throw new Error("HTTP 502 from GitHub");
    return getPr(...args);
  };
  const during = (route: StepRoute): StepRoute => ({
    ...route,
    runner: {
      run: async (input) => {
        inBaseRead = input.stepId.includes("@");
        try {
          return await route.runner.run(input);
        } finally {
          inBaseRead = false;
        }
      },
    },
  });
  return (route) => (route.match === "sh-fix-proof" ? during(route) : route);
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
function world(base: string, policy: EffectivePolicy, afterReview: (fake: FakeGitHub) => void = () => undefined, evidenceBase?: string, kind?: string): World {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, baseRef: base, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  fake.onGetPr = (pr) => {
    fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    fake.rules.contexts = pr.baseRef === "main" ? ["validate"] : [];
  };
  const proofRuns: { id: number; conclusion: string }[] = [];
  const listCheckRuns = fake.wire.listCheckRuns;
  const listed = ({ id, conclusion }: { id: number; conclusion: string }) => ({ ...successRun(FIX_PROOF_CHECK, id, undefined, conclusion), headSha: H1, pullRequests: [{ number: 1, baseRef: fake.pr(1).baseRef }] });
  fake.wire.listCheckRuns = async (...args) => [...(await listCheckRuns(...args)), ...proofRuns.map(listed)];
  const judged = (id: number, line: string, conclusion = "success") => (proofRuns.push({ id, conclusion }), fake.jobLogs.set(id, `2026-10-11T12:00:00.0000000Z ${line}`));
  const mergedInto: string[] = [];
  const merge = fake.wire.merge;
  fake.wire.merge = async (...args) => (mergedInto.push(fake.pr(1).baseRef), merge(...args));
  const store = shepherdStoreRef();
  let clock = 0;
  const onBase = evidenceBase === undefined ? (route: StepRoute) => route : evidenceReadOn(fake, evidenceBase);
  const prUnreadable = { on: false };
  const unreadable = prUnreadableInBaseReads(fake, prUnreadable);
  const wrap = (route: StepRoute) => unreadable(onBase(route));
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
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phasesFor(() => afterReview(fake)))], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(policy) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy, ...(kind !== undefined && { kind }) });
  return { fake, host, runId, mergedInto, judged, prUnreadable };
}

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

const REFUSED_JOB = 70;
const MAIN_JOB = 71;
const SKIPPED_JOB = 69;

/** A judge's line at H1; `base` is the base it judged, and a refused line also names the default branch it was not. */
function proofLine(verdict: FixProofResult["verdict"], base: string): string {
  const counts = { reproduces: verdict === "reproduced" ? 1 : 0, "passes-on-base": 0, "new-api": 0, "fails-on-head": 0, "not-run": 0 };
  const refused = verdict === "refused" && { defaultBranch: "main" };
  return formatResultLine({ head: H1, mergeBase: fakeSha("stack-merge-base"), verdict, counts, notCollected: [], deletedTests: [], configEdited: false, tests: [], truncated: false, base, ...refused });
}

const proofReads = (w: World, base: string) => Object.values(w.host.runtime.status(w.runId)!.stepResults).filter((result) => result.stepId === `sh-fix-proof:${H1}@${base}`);
const promptOf = (w: World) => w.host.gates.get(gateId(w.runId, "approve-merge"))?.prompt;
const OFF_BASE = `judged base ${PARENT}, not main, the base being decided`;

describe("a stacked PR whose fix-proof was refused on the parent branch, retargeted to main with the same head (TP-4259)", () => {
  /** A correctness PR on the parent whose only judge refused there; its review takes that refusal and writes MERGE. */
  const refused = (policy: EffectivePolicy = AUTO, files?: PrFile[]): World => {
    const w = world(PARENT, policy, undefined, undefined, "correctness");
    if (files !== undefined) w.fake.prFiles.set(1, files);
    w.judged(REFUSED_JOB, proofLine("refused", PARENT));
    return w;
  };

  it("merges nothing into main on that MERGE until a fix-proof line judged on main at the head is read, past a title edit's skipped judge", async () => {
    const w = refused();
    w.judged(SKIPPED_JOB, "Run pnpm fix-proof", "skipped");
    let mergesAtMainRead: number | undefined;
    const getJobLog = w.fake.wire.getJobLog;
    w.fake.wire.getJobLog = async (repo, jobId) => {
      if (jobId === REFUSED_JOB && w.fake.pr(1).baseRef === "main" && mergesAtMainRead === undefined) {
        mergesAtMainRead = w.fake.effects.merge;
        w.judged(MAIN_JOB, proofLine("reproduced", "main"));
      }
      return getJobLog(repo, jobId);
    };
    await waitingForRetarget(w);

    w.fake.pr(1).baseRef = "main";
    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true));

    expect(mergesAtMainRead).toBe(0);
    expect(w.mergedInto).toEqual(["main"]);
    expect(proofReads(w, "main").at(-1)!.data).toMatchObject({ result: { kind: "result", verdict: "reproduced", line: proofLine("reproduced", "main") } });
  });

  /** Retargets the refused PR to main beside `lines` judged there, and waits for the owner gate a read that does not stand opens. */
  const gatedOnMain = async (lines: string[], files?: PrFile[]): Promise<World> => {
    const w = refused(AUTO, files);
    lines.forEach((line, i) => w.judged(MAIN_JOB + i, line));
    await waitingForRetarget(w);
    w.fake.pr(1).baseRef = "main";
    await gateOpened(w.host, gateId(w.runId, "approve-merge"));
    return w;
  };

  it.each([
    ["only the refused line stands at the head", [], "no fix-proof run at this head judged the PR's base before the deadline"],
    ["the line on main is vacuous", [proofLine("vacuous", "main")], "its fix-proof on main is NO_REPRO (vacuous)"],
    ["the line on main is an error", [proofLine("error", "main")], "its fix-proof on main is unverified: error"],
    ["two runs judged main at the head", [proofLine("reproduced", "main"), proofLine("reproduced", "main")], "2 fix-proof runs at this head belong to PR #1 and judged main, not exactly one"],
  ])("asks the owner instead of merging when %s", async (_scene, lines, reason) => {
    const w = await gatedOnMain(lines);

    expect(w.fake.effects.merge).toBe(0);
    expect(promptOf(w)).toContain(OFF_BASE);
    expect(promptOf(w)).toContain(reason);
    expect(proofReads(w, "main").length).toBeGreaterThan(0);
  });

  it("asks the owner instead of merging when the PR changes the fix-proof harness, whatever the line on main says", async () => {
    const w = await gatedOnMain([proofLine("reproduced", "main")], [{ path: "src/a.ts", status: "modified" }, { path: "scripts/fix-proof-run.sh", status: "modified" }]);

    expect(w.fake.effects.merge).toBe(0);
    expect(promptOf(w)).toContain(OFF_BASE);
    expect(promptOf(w)).toContain("its fix-proof on main is unverified: untrusted");
    expect(promptOf(w)).toContain("harness: scripts/fix-proof-run.sh");
  });

  it("reads nothing again and merges on a seat that merges into the parent branch the proof was refused on", async () => {
    const w = refused({ ...AUTO, featureBase: true });
    const served = w.fake.onGetPr;
    w.fake.onGetPr = (pr, count) => {
      served?.(pr, count);
      w.fake.rules.contexts = ["validate"];
    };

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true));

    expect(w.mergedInto).toEqual([PARENT]);
    expect(stepIds(w).filter((id) => id.startsWith(`sh-fix-proof:${H1}@`))).toEqual([]);
  });

  it("asks the owner instead of merging when the re-read on main cannot read the fix/ PR's head branch, never reading it as skipped", async () => {
    const w = world(PARENT, AUTO, undefined, undefined, "feature");
    w.fake.pr(1).headRef = "fix/stacked";
    w.judged(REFUSED_JOB, proofLine("refused", PARENT));
    w.prUnreadable.on = true;
    await waitingForRetarget(w);

    w.fake.pr(1).baseRef = "main";
    await gateOpened(w.host, gateId(w.runId, "approve-merge"));

    expect(w.fake.effects.merge).toBe(0);
    expect(proofReads(w, "main").at(-1)!.data).toMatchObject({ result: { kind: "error", reason: expect.stringContaining("head branch unreadable") } });
    expect(promptOf(w)).toContain(OFF_BASE);
    expect(promptOf(w)).toContain("its fix-proof on main is unverified: unread (head branch unreadable");
  });

  it("still guards a MERGE whose record names no proof base, on the base its review read the evidence on", async () => {
    const w = world(PARENT, AUTO, undefined, undefined, "correctness");
    w.judged(REFUSED_JOB, "Run pnpm fix-proof");
    await waitingForRetarget(w);

    w.fake.pr(1).baseRef = "main";
    await gateOpened(w.host, gateId(w.runId, "approve-merge"));

    const evidence = Object.values(w.host.runtime.status(w.runId)!.stepResults).find((result) => result.stepId === `${MERGE_EVIDENCE_STEP}:${H1}`);
    expect(evidence!.data).toMatchObject({ result: { record: { baseRef: PARENT, proofUnverified: expect.stringContaining("unread") } } });
    expect(evidence!.data).not.toMatchObject({ result: { record: { proofBase: expect.anything() } } });
    expect(w.fake.effects.merge).toBe(0);
    expect(promptOf(w)).toContain(OFF_BASE);
    expect(promptOf(w)).toContain("its fix-proof on main is unverified: unread");
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
