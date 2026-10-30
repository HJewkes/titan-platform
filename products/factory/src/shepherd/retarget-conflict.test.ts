import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { WorkflowRunStore } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { MergeOrder } from "./merge-order.js";
import type { ShepherdPhases, WakeRequest } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { mergeVerdict } from "./review.js";
import { unresolvedRefs } from "./stale-base.js";
import { shepherdStoreRef } from "./store.js";
import { describeWake } from "./wake-brief.js";

const PARENT = "agent-chat/parent";
const PATH = "packages/demo/src/a.ts";
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = partialFake<SourceTextLocator>({});
const WAIT = { timeout: 5_000, interval: 5 };

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface World {
  fake: FakeGitHub;
  host: FactoryHost;
  runId: string;
  wakes: WakeRequest[];
  told: string[];
  /** Heads GitHub reads as conflicting with the base. */
  dirty: Set<string>;
  /** While on, each fixer push still conflicts, as a failed resolve would. */
  stillConflicts: { on: boolean };
  /** Heads whose dag-check is red. */
  red: Set<string>;
}

const DAG_CHECK_JOB = 2;
const INVALID_REFERENCE = `Error: git worktree add --detach /tmp/baseline origin/${PARENT}: invalid reference`;

const phases = (w: () => World): ShepherdPhases => ({
  review: (ctx, request) =>
    mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] }),
  wake: async (_ctx, request) => {
    const world = w();
    world.wakes.push(request);
    const head = fakeSha(`fix-${world.wakes.length}`);
    if (world.stillConflicts.on) world.dirty.add(head);
    world.fake.pushHead(1, head);
    return { kind: "woken", agent: "impl-a" };
  },
});

/** An open reservation over the PR's paths, made earlier by a run that never merges, so an order wait would last to the TTL. */
function earlierReservation(host: FactoryHost, fake: FakeGitHub): void {
  const since = "1970-01-01T00:00:00.000Z";
  fake.addPr({ number: 2, headSha: fakeSha("peer"), mergeSha: fakeSha("peer-merge") });
  new WorkflowRunStore(host.db).create({ id: "run-peer", workflowName: "stand-in", params: { repo: REPO }, status: "running", currentStep: null, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: since, completedAt: null, error: null });
  new MergeOrder(host.db).reserve({ repo: REPO, runId: "run-peer", pr: 2, headSha: fakeSha("peer"), baseSha: fake.refs.get("main")!, paths: [PATH], ahead: [], since, reason: "peer conflict" });
}

/** A child PR stacked on `PARENT` under an enabled merge order, by default behind an earlier overlapping reservation. */
function world({ reserved = true, baseRef = PARENT, red = [] as string[] } = {}): World {
  const late: { w?: World } = {};
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, baseRef, mergeSha: fakeSha("child-merge") });
  fake.prFiles.set(1, [{ path: PATH, status: "modified" }]);
  const dirty = new Set<string>();
  const redHeads = new Set(red);
  fake.onGetPr = (pr) => {
    fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", DAG_CHECK_JOB, undefined, redHeads.has(pr.headSha) ? "failure" : "success")]);
    fake.rules.contexts = pr.baseRef === "main" ? ["validate", "dag-check"] : [];
    if (pr.number === 1 && pr.state === "open") pr.mergeableState = dirty.has(pr.headSha) ? "dirty" : "clean";
  };
  let clock = Date.parse("2026-10-30T05:00:00.000Z");
  const told: string[] = [];
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({
    port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)),
    holdPollMs: 1, registry: async () => "trusted" as const, mergeTree: async () => "clean", park: async () => ({ lines: [] }),
    mergeOrderRules: () => ({ enabled: true, ttlMinutes: 1e9, ignore: [] }),
    exitNotice: { seatFor: () => "demo-seat", lastReport: async () => undefined, send: async (seat: string, text: string) => void told.push(`${seat}: ${text}`) },
  });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases(() => late.w!))], routes, gatePollMs: 5 });
  hosts.push(host);
  if (reserved) earlierReservation(host, fake);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  return (late.w = { fake, host, runId, wakes: [], told, dirty, stillConflicts: { on: false }, red: redHeads });
}

const stepIds = (w: World): string[] => Object.keys(w.host.runtime.status(w.runId)!.stepResults);

/** The parent squash-merges: GitHub retargets the child to main, where it may conflict with the squash. */
async function parentMerged(w: World, conflicting: boolean): Promise<void> {
  await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toMatch(/^base-wait/), WAIT);
  if (conflicting) w.dirty.add(H1);
  w.fake.pr(1).baseRef = "main";
}

describe("a stacked child retargeted to main after its parent squash-merged (TP-4566)", () => {
  it("wakes the implementer for one conflict round at once, with no merge-order wait", async () => {
    const w = world();

    await parentMerged(w, true);

    await vi.waitFor(() => expect(w.wakes).toHaveLength(1), WAIT);
    expect(w.wakes[0]).toMatchObject({ kind: "conflict", pr: 1, headSha: H1, payload: { mergeableState: "dirty" } });
    expect(stepIds(w).filter((id) => id.startsWith("sh-order-"))).toEqual([]);
    expect(stepIds(w).filter((id) => id.startsWith("sh-wake-fix-first"))).toEqual([]);
  });

  it("starts no fix round when the retargeted child is mergeable", async () => {
    const w = world({ reserved: false });

    await parentMerged(w, false);

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), WAIT);
    expect(w.wakes).toEqual([]);
  });

  it("wakes a fresh fixer after the implementer's head still conflicts, then tells the seat and wakes no third", async () => {
    const w = world();
    w.stillConflicts.on = true;

    await parentMerged(w, true);

    await vi.waitFor(() => expect(w.told.some((line) => line.includes("conflict"))).toBe(true), WAIT);
    expect(w.wakes.map((wake) => wake.payload)).toEqual([{ mergeableState: "dirty" }, { mergeableState: "dirty", freshFixer: true }]);
    expect(stepIds(w).filter((id) => id.startsWith("sh-order-"))).toEqual([]);
  });
});

describe("a red that ran on a base the PR no longer has (TP-4605)", () => {
  it("gives a retargeted child whose dag-check failed on an invalid reference a merge-main round, not a ci-red fix wake", async () => {
    const w = world({ reserved: false, baseRef: "main", red: [H1] });
    w.fake.jobLogs.set(DAG_CHECK_JOB, INVALID_REFERENCE);

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), WAIT);

    expect(w.wakes.map(({ kind, headSha, payload }) => ({ kind, headSha, payload }))).toEqual([{ kind: "conflict", headSha: H1, payload: { staleBase: PARENT } }]);
  });

  it("gives a child Shepherd saw retargeted a merge-main round, whatever its log says", async () => {
    const w = world({ reserved: false });
    w.fake.jobLogs.set(DAG_CHECK_JOB, "a failed assertion");

    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toMatch(/^base-wait/), WAIT);
    w.red.add(H1);
    w.fake.pr(1).baseRef = "main";

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), WAIT);
    expect(w.wakes.map(({ kind, payload }) => ({ kind, payload }))).toEqual([{ kind: "conflict", payload: { staleBase: PARENT } }]);
  });

  it("wakes ci-red for an invalid reference whose branch still exists", async () => {
    const w = world({ reserved: false, baseRef: "main", red: [H1] });
    w.fake.refs.set(PARENT, fakeSha("parent-tip"));
    w.fake.jobLogs.set(DAG_CHECK_JOB, INVALID_REFERENCE);

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), WAIT);

    expect(w.wakes.map((wake) => wake.kind)).toEqual(["ci-red"]);
  });

  it("wakes ci-red when the head the merge-main round pushed is red too", async () => {
    const w = world({ reserved: false, baseRef: "main", red: [H1, fakeSha("fix-1")] });
    w.fake.jobLogs.set(DAG_CHECK_JOB, INVALID_REFERENCE);

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), WAIT);

    expect(w.wakes.map((wake) => wake.kind)).toEqual(["conflict", "ci-red"]);
  });

  it("names the current and former bases and asks for a new head, even when the merge brings nothing", async () => {
    const fake = fakeGitHub();
    const pr = fake.addPr({ headSha: H1, baseRef: "main" });

    const { reason, payload } = await describeWake(partialFake<GitHubPort>({}), { kind: "conflict", repo: REPO, pr: 1, headSha: H1, payload: { staleBase: PARENT } }, pr);

    expect(reason).toContain("git merge origin/<base>");
    expect(reason).toContain("--allow-empty");
    expect(reason).not.toContain("conflicts with");
    expect(payload).toContain("main");
    expect(payload).toContain(PARENT);
  });

  it.each([
    ["git's own message", `fatal: invalid reference: origin/${PARENT}`, [PARENT]],
    ["a wrapped message", INVALID_REFERENCE, [PARENT]],
    ["an unrelated failure", `error: pathspec origin/${PARENT} did not match`, []],
    ["no remote ref", "fatal: invalid reference: HEAD~1", []],
  ])("reads the unresolved refs of %s", (_name, log, refs) => {
    expect(unresolvedRefs(log)).toEqual(refs);
  });
});
