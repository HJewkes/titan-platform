import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort, type PullRequest } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { LEDGER_FIXTURES, type HeadScript, type LedgerFixture, type MainScript, type Pinned, type ReviewAnswer } from "../test-support/ledger-fixtures.js";
import { factoryRoutesFor } from "../workflows.js";
import { MAX_UPDATE_CYCLES, sleep } from "../workflows/land.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import { freezeStoreRef } from "./freeze.js";
import type { MainRedWiring } from "./main-red.js";
import type { ReviewRequest, ShepherdPhases, Verdict, WakeOutcome } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { mergeVerdict, type ReviewWiring, type ReviewerAgent } from "./review.js";
import { ESCALATIONS } from "./route-table.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";
import type { Git, GitResult } from "./tree-carry.js";

const REPO = "acme/widgets";
const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const LOCATOR = { sourceId: "synthetic-transcript" } as unknown as SourceTextLocator;
const NEWER_MAIN = fakeSha("newer-main-push");
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** What a replay saw: reviewers Shepherd dispatched, review calls the fixture did not script, and fixers spawned. */
interface Trace {
  reviewers: number;
  unscripted: string[];
  fixers: string[];
}

interface Replay {
  fixture: LedgerFixture;
  fake: FakeGitHub;
  store: ShepherdStore;
  trace: Trace;
  /** Heads in the order the run first read them; a head's index picks its script. */
  seen: string[];
  wentBehind: Set<string>;
  reviewsAt: Map<string, number>;
  /** Heads at which the hold's reviewer answered MERGE in its own session. */
  heldMerges: string[];
  /** Heads at which a seat reviewer said FIX_FIRST. */
  seatObjections: string[];
  runId: string;
}

function headOf(replay: Replay, sha: string): HeadScript {
  if (!replay.seen.includes(sha)) replay.seen.push(sha);
  return replay.fixture.heads[replay.seen.indexOf(sha)] ?? {};
}

/** Applies the head's scripted state on every read, so GitHub reports what the gate's run saw at that head. */
function readHead(replay: Replay, pr: PullRequest): void {
  const head = headOf(replay, pr.headSha);
  const state = replay.wentBehind.has(pr.headSha) ? "behind" : (head.state ?? "clean");
  Object.assign(pr, { mergeableState: state, behind: state === "behind" });
  const runs = [successRun("validate", 1), successRun("dag-check", 2)];
  replay.fake.setRuns(pr.headSha, unreviewedBehind(head) ? runs.map((run) => ({ ...run, status: "in_progress", conclusion: null })) : runs);
  if (head.seatFixFirst && !replay.seatObjections.includes(pr.headSha)) replay.seatObjections.push(pr.headSha);
  const registration = replay.store.byRun(replay.runId);
  if (head.hold && registration && !registration.held) replay.store.hold(replay.runId, "synthetic hold", `rv-${replay.fixture.id}`);
}

/** The recorded run updated this behind head before any review, which today means its own CI was still running there. */
function unreviewedBehind(head: HeadScript): boolean {
  return head.state === "behind" && head.reviews === undefined && !head.treeEqual;
}

function answerReview(replay: Replay, request: ReviewRequest): ReviewAnswer | undefined {
  const head = headOf(replay, request.headSha);
  const index = replay.reviewsAt.get(request.headSha) ?? 0;
  replay.reviewsAt.set(request.headSha, index + 1);
  const answer = head.reviews?.[index];
  if (answer === undefined) replay.trace.unscripted.push(`head ${replay.seen.indexOf(request.headSha)} review ${index}`);
  if (head.goesBehind && index === (head.reviews?.length ?? 0) - 1) replay.wentBehind.add(request.headSha);
  if (answer !== undefined && !answer.startsWith("held-")) replay.trace.reviewers += 1;
  if (answer === "held-MERGE") replay.heldMerges.push(request.headSha);
  return answer;
}

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });

/**
 * The tree probe's git, answering from the fixture: a head scripted `treeEqual` has the tree of its parent merged onto
 * main, any other head has a tree of its own. Heads are told apart by the order the run first read them.
 */
function scriptedGit(replay: Replay): Git {
  let head = "";
  let merged = "";
  return async (_dir, args) => {
    const [command, flag] = args;
    if (command === "fetch") head = args[6] ?? "";
    if (command === "rev-list") return ok(`${head} ${fakeSha("reviewed-parent")} ${fakeSha("main-base")}`);
    if (command === "merge-tree") return ok(`${(merged = `merged-${args[4]}`)}\n`);
    if (command !== "rev-parse" || flag === undefined) return ok();
    const script = headOf(replay, head);
    if (script.treeEqual && script.goesBehind) replay.wentBehind.add(head);
    return ok(script.treeEqual ? merged : `tree-of-${head}`);
  };
}

function scriptedPhases(replay: Replay): ShepherdPhases {
  const reviewer = { agentId: `rv-${replay.fixture.id}`, sessionId: "synthetic-session" };
  const merges = (ctx: Parameters<ShepherdPhases["review"]>[0], request: ReviewRequest): Promise<Verdict> =>
    mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator: LOCATOR }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] });
  return {
    review: async (ctx, request) => {
      const answer = answerReview(replay, request);
      if (answer === "MERGE" || answer === "held-MERGE") return merges(ctx, request);
      if (answer === "FIX_FIRST") return { kind: "FIX_FIRST", headSha: request.headSha, text: "synthetic finding" };
      return { kind: "none", cause: "no-verdict" };
    },
    wake: async (): Promise<WakeOutcome> => {
      replay.fake.pushHead(1, fakeSha(`f${replay.fixture.id}-h${replay.seen.length}`));
      return { kind: "woken", agent: "impl-a" };
    },
  };
}

const MAIN_RUNS: Record<MainScript, ReturnType<typeof successRun>> = {
  green: successRun("validate", 9),
  red: successRun("validate", 9, undefined, "failure"),
  "cancelled-superseded": successRun("validate", 9, undefined, "cancelled"),
};

/** Main CI at the merge commit follows the fixture; a superseded run has a newer main push that contains it and passes. */
function mainCi(fake: FakeGitHub, main: MainScript): GitHubPort {
  const port = githubPort(fake.wire);
  const atMerge = (sha: string): void => {
    fake.setRuns(sha, [MAIN_RUNS[main]]);
    if (main !== "cancelled-superseded") return;
    fake.refs.set("main", NEWER_MAIN);
    fake.compares.set(`${sha}...${NEWER_MAIN}`, { mergeBaseSha: sha, files: [] });
    fake.setRuns(NEWER_MAIN, [successRun("validate", 10)]);
  };
  return { ...port, checkRuns: async (repo, sha) => (fake.pr(1).merged && sha === fake.pr(1).mergeSha && atMerge(sha), port.checkRuns(repo, sha)) };
}

/** The hold's reviewer, independent of the implementer, whose session holds a verdict block for each head it answered MERGE at. */
function heldReviewer(replay: Replay): Omit<ReviewWiring, "isFrozen"> {
  const reviewer: ReviewerAgent = { name: `rv-${replay.fixture.id}`, agentId: `rv-${replay.fixture.id}`, sessionId: "synthetic-session", presence: "live", spawnedBy: null, predecessor: null };
  const implementer: ReviewerAgent = { name: "impl-a", agentId: "impl-a", sessionId: "impl-session", presence: "live", spawnedBy: null, predecessor: null };
  const seat: ReviewerAgent = { name: "tc-x-review", agentId: "tc-x-review", sessionId: "seat-session", presence: "live", spawnedBy: null, predecessor: null };
  const objected = (head: string, index: number) => ({ agentId: seat.agentId, sessionId: seat.sessionId, writtenAt: index, text: `Verdict: FIX_FIRST\nPR: ${REPO}#1\nHead: ${head}`, locator: LOCATOR });
  const refuse = async (): Promise<never> => Promise.reject(new Error("the replay starts no reviewer"));
  const said = (head: string, index: number) => ({ agentId: reviewer.agentId, sessionId: reviewer.sessionId, writtenAt: index, text: `Verdict: MERGE\nPR: ${REPO}#1\nHead: ${head}`, locator: LOCATOR });
  const carry = { stateDir: mkdtempSync(join(tmpdir(), "ledger-replay-")), git: scriptedGit(replay) };
  return { dispatch: { roster: async () => [implementer, reviewer, seat], spawn: refuse, resume: refuse }, reader: { read: async () => [...replay.heldMerges.map(said), ...replay.seatObjections.map(objected)] }, carry };
}

function fixerWiring(fixers: string[]): Omit<MainRedWiring, "freezes"> {
  return {
    tasks: { findByTag: async () => undefined, add: async () => "FX-1" },
    fixers: { roster: async () => fixers.map((name) => ({ name })), spawn: async (name) => void fixers.push(name) },
    checkoutFor: () => tmpdir(),
  };
}

function openReplay(replay: Replay): FactoryHost {
  let clock = 0;
  const tick = async (ms: number, signal: AbortSignal): Promise<void> => ((clock += ms), sleep(1, signal));
  const port = mainCi(replay.fake, replay.fixture.main ?? "green");
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port, store, freeze: freezeStoreRef(() => clock), now: () => clock, sleep: tick, registry: async () => true, mainRed: fixerWiring(replay.trace.fixers), review: heldReviewer(replay) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(scriptedPhases(replay)), landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  replay.store = store.get();
  return host;
}

function startReplay(fixture: LedgerFixture): { host: FactoryHost; replay: Replay } {
  const fake = fakeGitHub({ repo: REPO });
  const trace: Trace = { reviewers: 0, unscripted: [], fixers: [] };
  const replay: Replay = { fixture, fake, store: undefined as unknown as ShepherdStore, trace, seen: [], wentBehind: new Set(), reviewsAt: new Map(), heldMerges: [], seatObjections: [], runId: "" };
  const host = openReplay(replay);
  fake.reviewBypass = fixture.reviewBypass ?? false;
  fake.addPr({ headSha: fakeSha(`f${fixture.id}-h0`), mergeSha: fakeSha(`f${fixture.id}-test-merge`) });
  fake.prFiles.set(1, [{ path: "src/widget.ts", status: "modified" }]);
  fake.onGetPr = (pr) => readHead(replay, pr);
  replay.runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
  replay.store.register({ repo: REPO, pr: 1, runId: replay.runId, task: "demo/1", implementer: "impl-a", policy: AUTO_POLICY, kind: "correctness" });
  return { host, replay };
}

/** An approve-merge gate is named by the escalation its prompt gives; any other gate by its step. */
function gateName(stepId: string, prompt: string): string {
  if (stepId !== "approve-merge") return stepId;
  return Object.entries(ESCALATIONS).find(([, text]) => prompt.includes(text))?.[0] ?? stepId;
}

/** A run that ended without a merge settles as its status, which no pin expects. */
function settled(host: FactoryHost, replay: Replay): string | undefined {
  const run = host.runtime.status(replay.runId)!;
  if (run.status === "completed" || run.status === "failed") return replay.fake.pr(1).merged ? "merged" : run.status;
  if (host.pendingGates().some((gate) => gate.runId === replay.runId)) return "gated";
  const held = replay.store.byRun(replay.runId)?.held === true;
  return held && /^merge(:|$)/.test(run.currentStep ?? "") ? "held-in-merge" : undefined;
}

/** A held run is read again after a pause, so a merge that slipped through the hold shows as merged. */
async function replayed(fixture: LedgerFixture): Promise<Omit<Pinned, "outcome"> & { outcome: string; unscripted: string[] }> {
  const { host, replay } = startReplay(fixture);
  await vi.waitFor(() => expect(settled(host, replay)).toBeDefined(), { timeout: 5_000, interval: 10 });
  if (settled(host, replay) === "held-in-merge") await sleep(100, new AbortController().signal);
  const gates = host.pendingGates().filter((gate) => gate.runId === replay.runId);
  const { reviewers, unscripted, fixers } = replay.trace;
  return { outcome: settled(host, replay)!, gates: gates.map((gate) => gateName(gate.stepId, gate.gate.prompt)), reviewers, fixers: fixers.length, unscripted };
}

describe("the ledger replay of the 2026-09-29..10-01 owner gates", () => {
  it("covers the 14 approve-merge and 3 main-red gates once each", () => {
    expect(LEDGER_FIXTURES.map((fixture) => fixture.id)).toEqual(Array.from({ length: 17 }, (_, index) => index + 1));
    expect(LEDGER_FIXTURES.filter((fixture) => fixture.gate === "main-red")).toHaveLength(3);
  });

  it.each(LEDGER_FIXTURES.map((fixture) => [fixture.id, fixture.story, fixture] as const))("fixture %i (%s) settles as pinned", async (_id, _story, fixture) => {
    const result = await replayed(fixture);

    expect(result).toEqual({ ...fixture.today, unscripted: [] });
  });
});

describe("a tree-equal update after a seat reviewer's FIX_FIRST", () => {
  const SEAT_CASE: Omit<LedgerFixture, "heads"> = { id: 99, gate: "approve-merge", story: "a seat reviewer objects at a tree-equal update", today: { outcome: "merged", gates: [], reviewers: 1, fixers: 0 } };
  const carriedComments = (replay: Replay) => (replay.fake.comments.get(1) ?? []).filter((comment) => comment.body.includes("Carried the MERGE"));

  it("carries when no seat reviewer objects", async () => {
    const { host, replay } = startReplay({ ...SEAT_CASE, heads: [{ reviews: ["MERGE"], goesBehind: true }, { treeEqual: true }] });
    await vi.waitFor(() => expect(settled(host, replay)).toBeDefined(), { timeout: 5_000, interval: 10 });

    expect(replay.fake.pr(1).merged).toBe(true);
    expect(carriedComments(replay)).toHaveLength(1);
  });

  it("neither merges nor carries at the head or at a later tree-equal update", async () => {
    const heads = [{ reviews: ["MERGE"], goesBehind: true }, { treeEqual: true, seatFixFirst: true, goesBehind: true }, { treeEqual: true }] satisfies HeadScript[];
    const { host, replay } = startReplay({ ...SEAT_CASE, heads });
    await vi.waitFor(() => expect(settled(host, replay)).toBeDefined(), { timeout: 5_000, interval: 10 });

    expect(replay.fake.pr(1).merged).toBe(false);
    expect(carriedComments(replay)).toHaveLength(0);
  });
});


describe("a base that moves on every read", () => {
  const BUSY: Omit<LedgerFixture, "heads"> = { id: 98, gate: "approve-merge", story: "main moves while each updated head's CI runs", today: { outcome: "merged", gates: [], reviewers: 1, fixers: 0 } };
  const behindCarry: HeadScript = { state: "behind", treeEqual: true };
  const short = (replay: Replay) => replay.seen.map((sha) => sha.slice(0, 7)).join(" -> ");

  it("reviews the behind head first, then merges after bounded updates that each carry the MERGE", async () => {
    const heads: HeadScript[] = [{ state: "behind", reviews: ["MERGE"] }, behindCarry, behindCarry, { treeEqual: true }];

    const { host, replay } = startReplay({ ...BUSY, heads });

    await vi.waitFor(() => expect(settled(host, replay)).toBe("merged"), { timeout: 5_000, interval: 10 });

    expect(replay.trace).toEqual({ reviewers: 1, unscripted: [], fixers: [] });
    expect(replay.fake.effects).toMatchObject({ updateBranch: MAX_UPDATE_CYCLES, merge: 1 });
    expect(host.pendingGates()).toEqual([]);
  });

  it(`stops at ${MAX_UPDATE_CYCLES} updates with a stuck-behind gate naming the count and every head`, async () => {
    const heads: HeadScript[] = [{ state: "behind", reviews: ["MERGE"] }, behindCarry, behindCarry, behindCarry];
    const { host, replay } = startReplay({ ...BUSY, heads });

    await vi.waitFor(() => expect(settled(host, replay)).toBe("gated"), { timeout: 5_000, interval: 10 });
    const [gate] = host.pendingGates().filter((pending) => pending.runId === replay.runId);

    expect(replay.trace).toEqual({ reviewers: 1, unscripted: [], fixers: [] });
    expect(replay.fake.effects).toMatchObject({ updateBranch: MAX_UPDATE_CYCLES, merge: 0 });
    expect(gate?.stepId).toBe("stuck-behind");
    expect(gate?.gate.prompt).toContain(`still behind its base after ${MAX_UPDATE_CYCLES} updates, heads ${short(replay)}`);
  });
});
