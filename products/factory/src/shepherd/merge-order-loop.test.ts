import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { WorkflowRunStore } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { mergeOrderGuard } from "./merge-order-guard.js";
import { blockers, MergeOrder, orderDriving, orderWaiting, type MergeOrderRules } from "./merge-order.js";
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
/** Out of reach of the fake clock, which every run's polls advance, so no wait here ends on the TTL. */
const ORDER = (enabled: boolean, ttlMinutes = 1e9): MergeOrderRules => () => ({ enabled, ttlMinutes, ignore: [".changeset/**"] });
const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = partialFake<SourceTextLocator>({});
/** Every poll of every run sleeps through the tick; a run that never stops waiting fails here instead of polling forever. */
const MAX_SLEEPS = 3_000;
const WAIT = { timeout: 5_000 };

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface Wake {
  kind: string;
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
  /** Runs inside each merge call, before GitHub merges `pr`. */
  beforeMerge: (pr: number) => Promise<void>;
  /** X's heads whose review sends X back with FIX_FIRST; X's fixer answers with a push that merges nothing. */
  fixFirstAt: Set<string>;
  /** Moves the clock every run reads, as a long fix round would. */
  advance: (ms: number) => void;
  /** Every seat message, as `seat: text`. */
  told: string[];
}

const merges: ShepherdPhases["review"] = (ctx, request) =>
  mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] });

/** X is dirty while Y or Z has merged and X's head has not merged it in. */
function conflictingRepo(loop: Pick<Loop, "merged" | "beforeMerge">, absorbed: Set<number>): FakeGitHub {
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
    await loop.beforeMerge(pr);
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

/** X's fixer merges the base it was woken at and pushes, or at a review wake pushes a fix that merges nothing; no other PR is ever woken. */
function fixerWake(loop: () => Loop, absorbed: Set<number>): ShepherdPhases["wake"] {
  return async (_ctx, request) => {
    const l = loop();
    if (request.pr !== X || (request.kind !== "conflict" && request.kind !== "review")) return { kind: "unhandled", reason: "only X's conflict and review are woken in this test" };
    const conflict = request.kind === "conflict";
    const mergedBefore = conflict ? [...l.merged] : [];
    const base = l.fake.refs.get("main")!;
    l.wakes.push({ kind: request.kind, headSha: request.headSha, mergedBefore });
    await l.duringWake();
    const head = fakeSha(`loop-fix-${l.wakes.length}`);
    l.fake.commits.set(head, { sha: head, parents: conflict ? [request.headSha, base] : [request.headSha] });
    mergedBefore.forEach((pr) => absorbed.add(pr));
    l.fake.pushHead(X, head);
    return { kind: "woken", agent: "impl-x" };
  };
}

function loopWorld(enabled: boolean, ttlMinutes?: number): Loop {
  const absorbed = new Set<number>();
  const late: { loop?: Loop } = {};
  const merged: number[] = [];
  const fake = conflictingRepo({ merged, beforeMerge: (pr) => late.loop!.beforeMerge(pr) }, absorbed);
  let clock = Date.parse("2026-10-23T10:00:00.000Z");
  let sleeps = 0;
  const tick = async (ms: number, signal: AbortSignal) => {
    if (++sleeps > MAX_SLEEPS) throw new Error(`still polling after ${MAX_SLEEPS} sleeps`);
    clock += ms;
    await sleep(1, signal);
  };
  const store = shepherdStoreRef();
  const port = landingPort(fake);
  const told: string[] = [];
  const exitNotice = { seatFor: () => "demo-seat", lastReport: async () => undefined, send: async (seat: string, text: string) => void told.push(`${seat}: ${text}`) };
  const routes = factoryRoutesFor({ port, store, now: () => clock, sleep: tick, holdPollMs: 1, registry: async () => "trusted" as const, mergeOrderRules: ORDER(enabled, ttlMinutes), park: async () => ({ lines: [] }), exitNotice });
  const review: ShepherdPhases["review"] = async (ctx, request) => {
    if (request.pr === Z) await late.loop!.beforeZReview();
    if (request.pr === X && late.loop!.fixFirstAt.has(request.headSha)) return { kind: "FIX_FIRST", headSha: request.headSha, text: "missing test" };
    return merges(ctx, request);
  };
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review, wake: fixerWake(() => late.loop!, absorbed) })], routes, gatePollMs: 5 });
  hosts.push(host);
  const noop = async () => undefined;
  const advance = (ms: number) => void (clock += ms);
  return (late.loop = { fake, host, store: store.get(), order: new MergeOrder(host.db), port, merged, wakes: [], runs: new Map(), duringWake: noop, beforeZReview: noop, beforeMerge: noop, fixFirstAt: new Set(), advance, told });
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

const orderEvents = (loop: Loop, runId: string): string[] => loop.store.eventsOf(runId).map((event) => event.kind).filter((kind) => kind.startsWith("order-"));

async function finish(loop: Loop, ...prs: number[]): Promise<void> {
  await Promise.all(prs.map((pr) => loop.host.runtime.wait(loop.runs.get(pr)!)));
}

/** A run the owner holds in its merge step, which reads as merging to every other run. */
function heldInMerge(loop: Loop, pr: number): string {
  const runId = shepherd(loop, pr);
  loop.store.hold(runId, "owner hold in this test");
  return runId;
}

/**
 * R stands in for an unheld conflicted run that reserved Y's paths while `ahead` was merging, so it waits on `ahead` and
 * holds the rest. It is a bare running run that never merges Y; a held one would order nothing (TP-4133).
 */
function reserveAhead(loop: Loop, ahead: string): string {
  return standIn(loop, { paths: [CAPABILITY], ahead: [ahead] });
}

/** A bare running run that reserved `paths` for Y before X could; `waiting` puts it in its own order-wait step. */
function standIn(loop: Loop, { paths, ahead = [], waiting = false }: { paths: string[]; ahead?: string[]; waiting?: boolean }): string {
  const since = "2026-10-23T09:59:00.000Z";
  const r = "run-r-stand-in";
  const activeSteps = waiting ? { "sh-order-wait:1": { stepId: "sh-order-wait:1", iterKey: "sh-order-wait:1:0", attempt: 0, startedAt: since, kind: "legacy" as const } } : {};
  new WorkflowRunStore(loop.host.db).create({ id: r, workflowName: "stand-in", params: { repo: REPO }, status: "running", currentStep: null, stepResults: {}, activeSteps, revision: 0, ownerGeneration: 0, startedAt: since, completedAt: null, error: null });
  loop.order.reserve({ repo: REPO, runId: r, pr: Y, headSha: loop.fake.pr(Y).headSha, baseSha: loop.fake.refs.get("main")!, paths, ahead, since, reason: "R stands in" });
  return r;
}

const endReservation = (loop: Loop, r: string): void => void loop.order.release(REPO, r, { at: "2026-10-23T10:00:00.000Z" });

/** The PRs whose reservations `runId`'s own reservation waits behind now, as its order wait reads them. */
function waitsBehind(loop: Loop, runId: string): number[] {
  const reservations = loop.order.list(REPO);
  const own = reservations.find((reservation) => reservation.runId === runId)!;
  const self = { repo: REPO, runId, paths: own.paths };
  return blockers(self, reservations, ORDER(true)(REPO)!, Date.parse("2026-10-23T10:00:00.000Z"), orderDriving(loop.order, loop.store), orderWaiting(loop.order)).map((blocker) => blocker.reservation.pr);
}

/** X conflicts at its current head with nothing merged, until its fixer pushes. */
function dirtyUntilPushed(loop: Loop): void {
  const head = loop.fake.pr(X).headSha;
  loop.fake.onGetPr = ((greenRuns) => (pr, reads) => (greenRuns(pr, reads), pr.number === X && pr.headSha === head && (pr.mergeableState = "dirty")))(loop.fake.onGetPr!);
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

  it("never counts a run held behind a live reservation as merging ahead, so three runs never wait in a ring", async () => {
    const loop = loopWorld(true);
    const x = heldInMerge(loop, X);
    await vi.waitFor(() => expect(currentStep(loop, X)).toMatch(/^merge:/), WAIT);
    const r = reserveAhead(loop, x);
    shepherd(loop, Z);
    await vi.waitFor(() => expect(currentStep(loop, Z)).toMatch(/^merge:/), WAIT);

    dirtyUntilPushed(loop);
    loop.store.release(x);
    await finish(loop, X);
    endReservation(loop, r);
    await finish(loop, Z);

    expect(results(loop, X, "sh-order-reserve")).toEqual([{ reserved: true, ahead: [] }]);
    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [], moved: false }]);
    expect(loop.wakes).toHaveLength(1);
    expect(loop.merged).toEqual([X, Z]);
  });

  it("stops waiting on a run it let merge first once that run is held behind a live reservation", async () => {
    const loop = loopWorld(true);
    const z = heldInMerge(loop, Z);
    await vi.waitFor(() => expect(currentStep(loop, Z)).toMatch(/^merge:/), WAIT);
    dirtyUntilPushed(loop);
    const x = shepherd(loop, X);
    await vi.waitFor(() => expect(currentStep(loop, X)).toMatch(/^sh-order-wait/), WAIT);

    const r = reserveAhead(loop, x);
    await finish(loop, X);
    endReservation(loop, r);
    loop.store.release(z);
    await finish(loop, Z);

    expect(results(loop, X, "sh-order-reserve")).toEqual([{ reserved: true, ahead: [z] }]);
    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [Z], moved: false }]);
    expect(loop.wakes).toHaveLength(1);
    expect(loop.merged).toEqual([X, Z]);
  });

  it("never waits behind an earlier overlapping reservation whose run a person holds (TP-4133)", async () => {
    const loop = loopWorld(true);
    const r = reserveAhead(loop, "run-none");
    loop.store.register({ repo: REPO, pr: Y, runId: r, task: `demo/${Y}`, implementer: `impl-${Y}`, policy: AUTO_POLICY });
    loop.store.hold(r, "g10-adversary: policy touch");
    dirtyUntilPushed(loop);

    shepherd(loop, X);
    await finish(loop, X);

    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [], moved: false }]);
    expect(loop.merged).toEqual([X]);
  });

  it("stops waiting on a run it let merge first once that run leaves its merge step unmerged", async () => {
    const loop = loopWorld(true);
    const zAtWake: (string | undefined)[] = [];
    await afterY(loop);
    const z = heldInMerge(loop, Z);
    loop.duringWake = async () => void zAtWake.push(loop.host.runtime.status(z)?.status);
    await vi.waitFor(() => expect(currentStep(loop, Z)).toMatch(/^merge:/), WAIT);
    shepherd(loop, X);
    await vi.waitFor(() => expect(currentStep(loop, X)).toMatch(/^sh-order-wait/), WAIT);

    const red = fakeSha("loop-z-red");
    loop.fake.onGetPr = ((greenRuns) => (pr, reads) => (greenRuns(pr, reads), pr.headSha === red && loop.fake.setRuns(red, [successRun("validate", 3, undefined, "failure")])))(loop.fake.onGetPr!);
    loop.fake.pushHead(Z, red);
    await finish(loop, X);
    loop.host.runtime.cancel(z, "ended in this test");

    expect(zAtWake).toEqual(["running"]);
    expect(results(loop, X, "sh-order-reserve")).toEqual([{ reserved: true, ahead: [z] }]);
    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [Z], moved: false }]);
    expect(loop.merged).toEqual([Y, X]);
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
    expect(orderEvents(loop, x)).toEqual(["order-reserve", "order-release"]);
  });

  it("logs the expiry once and tells the seat once when the reservation outlives its TTL", async () => {
    const loop = loopWorld(true, 60);
    loop.duringWake = async () => loop.advance(2 * 60 * 60_000);
    await afterY(loop);

    const x = shepherd(loop, X);
    await finish(loop, X);

    expect(loop.merged).toEqual([Y, X]);
    expect(results(loop, X, "sh-order-expire")).toEqual([{ expired: true, ttlMinutes: 60 }]);
    expect(orderEvents(loop, x)).toEqual(["order-reserve", "order-expired"]);
    expect(loop.told).toEqual([expect.stringMatching(/^demo-seat: Shepherd: hjewkes\/titan-platform#2301 .*merge order: its reservation passed the 60 min TTL/)]);
  });
});

/** The resolved head of X's first conflict wake, and the head its review fix pushes after it. */
const RESOLVED = fakeSha("loop-fix-1");
const REVIEW_FIXED = fakeSha("loop-fix-2");

describe("TP-4497: a reservation is held only through a conflict round or at a landable head", () => {
  it("a review fix round releases the reservation and a ready overlapping PR lands", async () => {
    const loop = loopWorld(true);
    const during: string[][] = [];
    loop.fixFirstAt.add(RESOLVED);
    loop.duringWake = async () => {
      if (loop.wakes.at(-1)?.kind !== "review") return;
      during.push(loop.order.list(REPO).map((reservation) => reservation.runId));
      shepherd(loop, Z);
      await vi.waitFor(() => expect(loop.merged).toContain(Z), WAIT);
    };
    dirtyUntilPushed(loop);

    const x = shepherd(loop, X);
    await finish(loop, X);
    await finish(loop, Z);

    expect(during).toEqual([[]]);
    expect(loop.merged).toEqual([Z, X]);
    expect(loop.wakes.map((wake) => wake.kind)).toEqual(["conflict", "review", "conflict"]);
    expect(orderEvents(loop, x)).toEqual(["order-reserve", "order-release", "order-reserve", "order-release"]);
  });

  it("a run back at a landable head after a review fix takes its reservation again and the order is respected", async () => {
    const loop = loopWorld(true);
    const held: string[] = [];
    const reasons: (string | undefined)[] = [];
    loop.fixFirstAt.add(RESOLVED);
    loop.beforeMerge = async (pr) => {
      if (pr !== X) return;
      held.push(...loop.order.list(REPO).map((reservation) => reservation.reason));
      shepherd(loop, Z);
      reasons.push(await orderReasonForZ(loop));
    };
    dirtyUntilPushed(loop);

    const x = shepherd(loop, X);
    await finish(loop, X);
    await finish(loop, Z);

    expect(held).toEqual([`landable again at ${REVIEW_FIXED}`]);
    expect(reasons).toEqual([`merge order: waiting behind #${X} (${CAPABILITY})`]);
    expect(loop.merged).toEqual([X, Z]);
    expect(orderEvents(loop, x)).toEqual(["order-reserve", "order-release", "order-reserve", "order-release"]);
  });
});

describe("TP-4501: a run waiting for its turn orders only other waiters", () => {
  it("a run waiting in order-wait does not block a ready overlapping PR", async () => {
    const loop = loopWorld(true);
    const r = standIn(loop, { paths: ["products/explainer/README.md"] });
    dirtyUntilPushed(loop);
    shepherd(loop, X);
    await vi.waitFor(() => expect(currentStep(loop, X)).toMatch(/^sh-order-wait/), WAIT);

    shepherd(loop, Z);
    await finish(loop, Z);
    endReservation(loop, r);
    await finish(loop, X);

    expect(loop.merged).toEqual([Z, X]);
    expect(loop.wakes.map((wake) => wake.mergedBefore)).toEqual([[Z]]);
    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [Y], moved: false }]);
  });

  it("two overlapping waiters resolve in reservation order without deadlock", async () => {
    const loop = loopWorld(true);
    const w = standIn(loop, { paths: [CAPABILITY], waiting: true });
    dirtyUntilPushed(loop);
    const x = shepherd(loop, X);
    await vi.waitFor(() => expect(currentStep(loop, X)).toMatch(/^sh-order-wait/), WAIT);
    const behind = [w, x].map((runId) => waitsBehind(loop, runId));

    endReservation(loop, w);
    await finish(loop, X);

    expect(behind).toEqual([[], [Y]]);
    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [Y], moved: false }]);
    expect(loop.merged).toEqual([X]);
  });
});
