import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { mergeOrderGuard } from "./merge-order-guard.js";
import { MergeOrder, type MergeOrderRules } from "./merge-order.js";
import type { ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";

/** The #2301 loop (TP-4098): X conflicts once Y lands, and again if Z lands inside X's resolve window. */
const REPO = "hjewkes/titan-platform";
const X = 2301;
const Y = 2310;
const Z = 2311;
const CAPABILITY = "products/explainer/CAPABILITY.md";
const FILES: Readonly<Record<number, string[]>> = { [X]: [CAPABILITY, "products/explainer/README.md"], [Y]: [CAPABILITY, "products/explainer/README.md"], [Z]: [CAPABILITY] };
const ORDER = (enabled: boolean): MergeOrderRules => () => ({ enabled, ttlMinutes: 10_000, ignore: [".changeset/**"] });
const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = partialFake<SourceTextLocator>({});
/** Every poll of every run sleeps through the tick; a run that never stops waiting fails here instead of polling forever. */
const MAX_SLEEPS = 3_000;
const WAIT = { timeout: 5_000 };

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface Wake {
  headSha: string;
  /** What GitHub had merged when the fixer started: the base it merges. */
  mergedBefore: number[];
}

interface Loop {
  fake: FakeGitHub;
  host: FactoryHost;
  store: ShepherdStore;
  order: MergeOrder;
  port: GitHubPort;
  merged: number[];
  wakes: Wake[];
  runs: Map<number, string>;
  /** Runs while X's fixer works, before it pushes the head that merges the base it started at. */
  duringWake: () => Promise<void>;
  /** Runs before Z's review; the scenario holds Z there until X's conflict is under way. */
  beforeZReview: () => Promise<void>;
}

const merges: ShepherdPhases["review"] = (ctx, request) =>
  mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] });

/** X is dirty while Y or Z has merged and X's head has not merged it in. */
function conflictingRepo(loop: Pick<Loop, "merged">, absorbed: Set<number>): FakeGitHub {
  const fake = fakeGitHub({ repo: REPO });
  fake.onGetPr = (pr) => {
    fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    if (pr.number === X && pr.state === "open") pr.mergeableState = [Y, Z].some((peer) => fake.pr(peer).merged && !absorbed.has(peer)) ? "dirty" : "clean";
  };
  for (const pr of [X, Y, Z]) {
    fake.addPr({ number: pr, headSha: fakeSha(`loop-${pr}`), mergeSha: fakeSha(`loop-merge-${pr}`) });
    fake.prFiles.set(pr, FILES[pr]!.map((path) => ({ path, status: "modified" as const })));
  }
  const merge = fake.wire.merge;
  fake.wire.merge = async (slug, pr, sha, method) => {
    const result = await merge(slug, pr, sha, method);
    loop.merged.push(pr);
    return result;
  };
  return fake;
}

/** Main CI after each merge reads green. */
function landingPort(fake: FakeGitHub): GitHubPort {
  const port = githubPort(fake.wire);
  const mergeShas = () => [X, Y, Z].map((pr) => fake.pr(pr).mergeSha);
  return { ...port, checkRuns: async (slug, sha) => (mergeShas().includes(sha) && fake.setRuns(sha, [successRun("validate", 9), successRun("dag-check", 10)]), port.checkRuns(slug, sha)) };
}

/** X's fixer merges the base it was woken at and pushes; no other PR is ever woken. */
function fixerWake(loop: () => Loop, absorbed: Set<number>): ShepherdPhases["wake"] {
  return async (_ctx, request) => {
    const l = loop();
    if (request.pr !== X || request.kind !== "conflict") return { kind: "unhandled", reason: "only X's conflict is woken in this test" };
    const mergedBefore = [...l.merged];
    const base = l.fake.refs.get("main")!;
    l.wakes.push({ headSha: request.headSha, mergedBefore });
    await l.duringWake();
    const head = fakeSha(`loop-fix-${l.wakes.length}`);
    l.fake.commits.set(head, { sha: head, parents: [request.headSha, base] });
    mergedBefore.forEach((pr) => absorbed.add(pr));
    l.fake.pushHead(X, head);
    return { kind: "woken", agent: "impl-x" };
  };
}

function loopWorld(enabled: boolean): Loop {
  const absorbed = new Set<number>();
  const late: { loop?: Loop } = {};
  const merged: number[] = [];
  const fake = conflictingRepo({ merged }, absorbed);
  let clock = Date.parse("2026-10-23T10:00:00.000Z");
  let sleeps = 0;
  const tick = async (ms: number, signal: AbortSignal) => {
    if (++sleeps > MAX_SLEEPS) throw new Error(`still polling after ${MAX_SLEEPS} sleeps`);
    clock += ms;
    await sleep(1, signal);
  };
  const store = shepherdStoreRef();
  const port = landingPort(fake);
  const routes = factoryRoutesFor({ port, store, now: () => clock, sleep: tick, holdPollMs: 1, registry: async () => "trusted" as const, mergeOrderRules: ORDER(enabled), park: async () => ({ lines: [] }) });
  const review: ShepherdPhases["review"] = async (ctx, request) => (request.pr === Z && (await late.loop!.beforeZReview()), merges(ctx, request));
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review, wake: fixerWake(() => late.loop!, absorbed) })], routes, gatePollMs: 5 });
  hosts.push(host);
  const noop = async () => undefined;
  return (late.loop = { fake, host, store: store.get(), order: new MergeOrder(host.db), port, merged, wakes: [], runs: new Map(), duringWake: noop, beforeZReview: noop });
}

function shepherd(loop: Loop, pr: number): string {
  const runId = loop.host.runtime.start("shepherd-pr", { repo: REPO, pr: String(pr), policy: JSON.stringify(AUTO_POLICY) });
  loop.store.register({ repo: REPO, pr, runId, task: `demo/${pr}`, implementer: `impl-${pr}`, policy: AUTO_POLICY });
  loop.runs.set(pr, runId);
  return runId;
}

const currentStep = (loop: Loop, pr: number): string | null | undefined => loop.host.runtime.status(loop.runs.get(pr)!)?.currentStep;
const results = (loop: Loop, pr: number, family: string): unknown[] =>
  Object.entries(loop.host.runtime.status(loop.runs.get(pr)!)!.stepResults).filter(([id]) => id.startsWith(family)).map(([, step]) => (step.data as { result?: unknown } | undefined)?.result);

async function finish(loop: Loop, ...prs: number[]): Promise<void> {
  await Promise.all(prs.map((pr) => loop.host.runtime.wait(loop.runs.get(pr)!)));
}

/** Y lands first, so X starts out conflicted; Z's review waits until X's conflict is under way. */
async function afterY(loop: Loop): Promise<void> {
  shepherd(loop, Y);
  await vi.waitFor(() => expect(loop.merged).toEqual([Y]), WAIT);
}

/** The reason the merge guard gives Z now, read the way Z's merge step reads it. */
function orderReasonForZ(loop: Loop): Promise<string | undefined> {
  const guard = mergeOrderGuard({ order: () => loop.order, registrations: () => loop.store, rules: ORDER(true), now: () => Date.parse("2026-10-23T10:00:00.000Z") });
  return guard.reason(loop.port, REPO, Z, "main", loop.fake.pr(Z).headSha, loop.fake.pr(Z).headRef);
}

describe("TP-4098 slice C: the #2301 loop", () => {
  it("with merge order off, a later overlapping merge re-conflicts the resolved PR", async () => {
    const loop = loopWorld(false);
    loop.beforeZReview = () => vi.waitFor(() => expect(loop.wakes.length).toBeGreaterThan(0), WAIT);
    loop.duringWake = () => vi.waitFor(() => expect(loop.merged).toContain(Z), WAIT);
    await afterY(loop);

    shepherd(loop, X);
    shepherd(loop, Z);
    await finish(loop, X, Z);

    expect(loop.merged).toEqual([Y, Z, X]);
    expect(loop.wakes).toHaveLength(2);
  });

  it("with merge order on, the conflicted PR is resolved once and lands before the next overlapping PR", async () => {
    const loop = loopWorld(true);
    const reasons: (string | undefined)[] = [];
    loop.beforeZReview = () => vi.waitFor(() => expect(loop.wakes.length).toBeGreaterThan(0), WAIT);
    loop.duringWake = async () => {
      await vi.waitFor(() => expect(currentStep(loop, Z)).toMatch(/^merge:/), WAIT);
      reasons.push(await orderReasonForZ(loop));
    };
    await afterY(loop);

    shepherd(loop, X);
    shepherd(loop, Z);
    await finish(loop, X, Z);

    expect(loop.merged).toEqual([Y, X, Z]);
    expect(loop.wakes).toHaveLength(1);
    expect(reasons).toEqual([`merge order: waiting behind #${X} (${CAPABILITY})`]);
    expect(results(loop, Z, "merge:")).toContainEqual(expect.objectContaining({ done: false, skipped: "held" }));
    expect([...results(loop, X, "sh-seat-notice"), ...results(loop, Z, "sh-seat-notice")]).toEqual([]);
  });

  it("lets a PR already in its merge step land first, then wakes the conflicted PR once at the base it leaves", async () => {
    const loop = loopWorld(true);
    await afterY(loop);
    const z = shepherd(loop, Z);
    loop.store.hold(z, "owner hold in this test");
    await vi.waitFor(() => expect(currentStep(loop, Z)).toMatch(/^merge:/), WAIT);

    shepherd(loop, X);
    await vi.waitFor(() => expect(loop.wakes.length > 0 || /^sh-order-wait/.test(currentStep(loop, X) ?? "")).toBe(true), WAIT);
    loop.store.release(z);
    await finish(loop, X, Z);

    expect(loop.merged).toEqual([Y, Z, X]);
    expect(loop.wakes).toHaveLength(1);
    expect(loop.wakes[0]!.mergedBefore).toEqual([Y, Z]);
    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [Z], moved: false }]);
  });

  it("skips the wake when the head moves during the order wait, and lands the next round", async () => {
    const loop = loopWorld(true);
    await afterY(loop);
    const z = shepherd(loop, Z);
    loop.store.hold(z, "owner hold in this test");
    await vi.waitFor(() => expect(currentStep(loop, Z)).toMatch(/^merge:/), WAIT);

    shepherd(loop, X);
    await vi.waitFor(() => expect(currentStep(loop, X)).toMatch(/^sh-order-wait/), WAIT);
    const pushed = fakeSha("loop-pushed");
    loop.fake.commits.set(pushed, { sha: pushed, parents: [loop.fake.pr(X).headSha, loop.fake.refs.get("main")!] });
    loop.fake.pushHead(X, pushed);
    loop.fake.onGetPr = ((greenRuns) => (pr, reads) => (greenRuns(pr, reads), pr.number === X && (pr.mergeableState = "clean")))(loop.fake.onGetPr!);
    await finish(loop, X);

    expect(loop.wakes).toEqual([]);
    expect(loop.merged).toEqual([Y, X]);
    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [Z], moved: true }]);
  });

  it("releases the reservation when its run lands", async () => {
    const loop = loopWorld(true);
    const during: string[][] = [];
    loop.duringWake = async () => void during.push(loop.order.list(REPO).map((reservation) => reservation.runId));
    await afterY(loop);

    const x = shepherd(loop, X);
    await finish(loop, X);

    expect(during).toEqual([[x]]);
    expect(loop.merged).toEqual([Y, X]);
    expect(loop.order.list(REPO)).toEqual([]);
  });
});
