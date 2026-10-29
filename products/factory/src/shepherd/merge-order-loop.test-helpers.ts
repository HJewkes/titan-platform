import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
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
export const REPO = "hjewkes/titan-platform";
export const X = 2301;
export const Y = 2310;
export const Z = 2311;
export const CAPABILITY = "products/explainer/CAPABILITY.md";
const FILES: Readonly<Record<number, string[]>> = { [X]: [CAPABILITY, "products/explainer/README.md"], [Y]: [CAPABILITY, "products/explainer/README.md"], [Z]: [CAPABILITY] };
/** Out of reach of the fake clock, which every run's polls advance, so no wait here ends on the TTL. */
const ORDER = (enabled: boolean, ttlMinutes = 1e9): MergeOrderRules => () => ({ enabled, ttlMinutes, ignore: [".changeset/**"] });
export const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = partialFake<SourceTextLocator>({});
/** Every poll of every run sleeps through the tick; a run that never stops waiting fails here instead of polling forever. */
const MAX_SLEEPS = 3_000;
export const WAIT = { timeout: 5_000 };

export const hosts: FactoryHost[] = [];

interface Wake {
  kind: string;
  headSha: string;
  /** What GitHub had merged when the fixer started: the base it merges. */
  mergedBefore: number[];
}

export interface Loop {
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
  /** Runs before each review of X, with the head it reviews. */
  beforeXReview: (headSha: string) => Promise<void>;
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
  mergeVerdict(ctx, {
    ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator },
    resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"],
  });

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

/** Every review merges, after the scenario's review hooks, except at X's heads in `fixFirstAt`. */
function loopReview(loop: () => Loop): ShepherdPhases["review"] {
  return async (ctx, request) => {
    if (request.pr === Z) await loop().beforeZReview();
    if (request.pr === X) await loop().beforeXReview(request.headSha);
    if (request.pr === X && loop().fixFirstAt.has(request.headSha)) return { kind: "FIX_FIRST", headSha: request.headSha, text: "missing test" };
    return merges(ctx, request);
  };
}

export function loopWorld(enabled: boolean, ttlMinutes?: number): Loop {
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
  const routes = factoryRoutesFor({
    port, store, now: () => clock, sleep: tick, holdPollMs: 1, registry: async () => "trusted" as const,
    mergeOrderRules: ORDER(enabled, ttlMinutes), park: async () => ({ lines: [] }), exitNotice,
  });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: loopReview(() => late.loop!), wake: fixerWake(() => late.loop!, absorbed) })], routes, gatePollMs: 5 });
  hosts.push(host);
  const noop = async () => undefined;
  const advance = (ms: number) => void (clock += ms);
  const hooks = { duringWake: noop, beforeZReview: noop, beforeXReview: noop, beforeMerge: noop, fixFirstAt: new Set<string>() };
  return (late.loop = { fake, host, store: store.get(), order: new MergeOrder(host.db), port, merged, wakes: [], runs: new Map(), ...hooks, advance, told });
}

export function shepherd(loop: Loop, pr: number): string {
  const runId = loop.host.runtime.start("shepherd-pr", { repo: REPO, pr: String(pr), policy: JSON.stringify(AUTO_POLICY) });
  loop.store.register({ repo: REPO, pr, runId, task: `demo/${pr}`, implementer: `impl-${pr}`, policy: AUTO_POLICY });
  loop.runs.set(pr, runId);
  return runId;
}

export const currentStep = (loop: Loop, pr: number): string | null | undefined => loop.host.runtime.status(loop.runs.get(pr)!)?.currentStep;
export const results = (loop: Loop, pr: number, family: string): unknown[] =>
  Object.entries(loop.host.runtime.status(loop.runs.get(pr)!)!.stepResults).filter(([id]) => id.startsWith(family)).map(([, step]) => (step.data as { result?: unknown } | undefined)?.result);

export const orderEvents = (loop: Loop, runId: string): string[] => loop.store.eventsOf(runId).map((event) => event.kind).filter((kind) => kind.startsWith("order-"));

export async function finish(loop: Loop, ...prs: number[]): Promise<void> {
  await Promise.all(prs.map((pr) => loop.host.runtime.wait(loop.runs.get(pr)!)));
}

/** X conflicts at its current head with nothing merged, until its fixer pushes. */
export function dirtyUntilPushed(loop: Loop): void {
  const head = loop.fake.pr(X).headSha;
  loop.fake.onGetPr = ((greenRuns) => (pr, reads) => (greenRuns(pr, reads), pr.number === X && pr.headSha === head && (pr.mergeableState = "dirty")))(loop.fake.onGetPr!);
}

/** The reason the merge guard gives Z now, read the way Z's merge step reads it. */
export function orderReasonForZ(loop: Loop): Promise<string | undefined> {
  const guard = mergeOrderGuard({ order: () => loop.order, registrations: () => loop.store, rules: ORDER(true), now: () => Date.parse("2026-10-23T10:00:00.000Z") });
  return guard.reason(loop.port, REPO, Z, "main", loop.fake.pr(Z).headSha, loop.fake.pr(Z).headRef);
}
