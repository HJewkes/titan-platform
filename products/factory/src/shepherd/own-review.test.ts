import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { callCommand } from "../test-support/shepherd.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ReviewAsk } from "./review-request.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { VERSION_PACKAGES_BRANCH } from "./release.js";
import { reviewPhase, type ReviewerAgent, type ReviewerDispatch, type ReviewerReader } from "./review.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const G10_ADVERSARY = "g10-adversary: merge-policy change; TP-1";
const G10_REVIEW = "g10-review: auth change; TP-1";
const SEAT_REVIEWER = "seat-x-review";
/** The registration's opt-in reviewer, exited with room left, so a review without an ask resumes it. */
const STANDING = "standing-rv";

/** Where a reviewer's verdict sits in its session; only the conversation's native id is read here. */
function locatorIn(sessionId: string): SourceTextLocator {
  const conversation = { harness: "claude-code", namespace: "test", nativeId: sessionId };
  const source = { sourceId: sessionId, harness: "claude-code", format: "claude-code-jsonl", formatVersion: null, path: "transcript.jsonl", namespace: "test", conversation, provenance: { kind: "claude-code-transcript" as const, legacySessionId: sessionId } };
  const evidence = { line: { sourceId: sessionId, byteOffset: 0, byteLength: 1, contentHash: "0", lineNumber: 1, nativeOrdinal: null }, subrecord: { index: 0, path: ["message"] } };
  return { source, evidence, selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] } };
}

const row = (name: string, presence: ReviewerAgent["presence"] = "exited"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null, fillTokens: 1_000 });

interface Reviewers {
  dispatch: ReviewerDispatch;
  reader: ReviewerReader;
  spawned: string[];
  resumed: string[];
}

/** What Shepherd's spawn number `spawn` writes at `head`; undefined is a reviewer that never answers. */
type Say = (spawn: number, head: string) => string | undefined;

const block = (verdict: "MERGE" | "FIX_FIRST", head: string, closer = ""): string => `Read the diff.\n\nVerdict: ${verdict}\nPR: ${REPO}#1\nHead: ${head}\n${closer}`;
const merges: Say = (_spawn, head) => block("MERGE", head);

/** The seat reviewer says MERGE unless `seatSilent`; Shepherd's spawns answer as `say` scripts them. */
function scriptedReviewers(seatSilent: boolean, say: Say): Reviewers {
  const agents: ReviewerAgent[] = [{ ...row("coord", "live"), spawnedBy: null }, row("impl-a"), row(SEAT_REVIEWER), row(STANDING)];
  const spawned: string[] = [];
  const resumed: string[] = [];
  const dispatch: ReviewerDispatch = { roster: async () => [...agents], spawn: async (name) => void (spawned.push(name), agents.push(row(name))), resume: async (name) => void resumed.push(name) };
  const text = (who: ReviewerAgent, head: string): string | undefined => {
    if (who.name === SEAT_REVIEWER) return seatSilent ? undefined : block("MERGE", head);
    return spawned.includes(who.name) ? say(spawned.indexOf(who.name), head) : block("MERGE", head);
  };
  const said = (who: ReviewerAgent, head: string) => {
    const written = text(who, head);
    return written === undefined ? [] : [{ agentId: who.agentId, sessionId: who.sessionId, writtenAt: Date.now(), text: written, locator: locatorIn(who.sessionId) }];
  };
  const reader: ReviewerReader = { read: async (input) => agents.filter((who) => who.agentId === input.reviewerAgentId).flatMap((who) => said(who, input.head)) };
  return { dispatch, reader, spawned, resumed };
}

interface World {
  host: FactoryHost;
  routes: FactoryRoutes;
  fake: FakeGitHub;
  store: ShepherdStore;
  runId: string;
  spawned: string[];
  resumed: string[];
}

interface Options {
  seatSilent?: boolean;
  /** Scripts Shepherd's spawns; with one, the clock is real and the waits are short, so a silent spawn times out. */
  say?: Say;
  standing?: boolean;
  branch?: string;
}

/** One green, clean head H1 under `hold`, with the hold's named reviewer when one is given. */
function heldRun(hold: string, reviewer?: string, { seatSilent = false, say, standing = false, branch }: Options = {}): World {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge"), mergeableState: "clean" });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  fake.setRuns(H1, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.onGetPr = (pr) => (fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]), (pr.mergeableState = "clean"));
  const reviewers = scriptedReviewers(seatSilent, say ?? merges);
  const wake: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "no fixer in this test" });
  const ref = shepherdStoreRef();
  const waits = say ? { timeoutMs: 20, lateVerdictMs: 5, exitGraceMs: 1 } : {};
  const review = { dispatch: reviewers.dispatch, reader: reviewers.reader, roles: { g10: "bd-reviewer", standard: "bd-reviewer" }, ...waits };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: say ? Date.now : () => 0, sleep: async (_ms, signal) => sleep(1, signal), holdPollMs: 1, review });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  const store = ref.get();
  const policy = standing ? { ...AUTO_POLICY, reviewer: STANDING } : AUTO_POLICY;
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(policy), ...(branch && { branch }) });
  store.register({ repo: REPO, pr: 1, ...(branch && { branch }), runId, task: "demo/1", implementer: "impl-a", policy, kind: "security" });
  store.hold(runId, hold, reviewer);
  return { host, routes, fake, store, runId, spawned: reviewers.spawned, resumed: reviewers.resumed };
}

const results = (w: World) => Object.values(w.host.runtime.status(w.runId)!.stepResults);
const resultsOf = (w: World, family: string): unknown[] => results(w).flatMap((result) => (result.stepId === `${family}:${H1}` ? [result.data?.["result"]] : []));
const waitingToMerge = (w: World): boolean => /^merge(:|$)/.test(w.host.runtime.status(w.runId)?.currentStep ?? "");
const ask = (w: World) => callCommand<ReviewAsk>(w.host, w.routes, "shepherd.review", { repo: REPO, pr: 1 });

describe("a hold that names a seat reviewer", () => {
  it("still spawns Shepherd's own reviewer under g10-adversary, and records the seat reviewer's MERGE as the hold's", async () => {
    const w = heldRun(G10_ADVERSARY, SEAT_REVIEWER);

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(w.spawned).toHaveLength(1);
    expect(resultsOf(w, "sh-review-intent")).toEqual([expect.objectContaining({ mode: "spawn", reviewer: w.spawned[0] })]);
    expect(resultsOf(w, "sh-review")).toEqual([expect.objectContaining({ kind: "dispatched", reviewer: w.spawned[0] })]);
    expect(w.store.byRun(w.runId)?.holdSatisfied).toMatchObject({ head: H1, by: { reviewer: SEAT_REVIEWER } });
  });

  it("takes the seat reviewer's verdict as the review under g10-review, which needs only one", async () => {
    const w = heldRun(G10_REVIEW, SEAT_REVIEWER);

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(w.spawned).toEqual([]);
    expect(resultsOf(w, "sh-review-intent")).toEqual([expect.objectContaining({ mode: "external", reviewer: SEAT_REVIEWER })]);
  });
});

const gatePrompt = (w: World): string | undefined => w.host.pendingGates().find((gate) => gate.runId === w.runId)?.gate.prompt;

/** Releases the hold once the run took the ask, then waits for the run to merge or open approve-merge. */
async function releasedAfterAsk(w: World): Promise<void> {
  await vi.waitFor(() => expect(w.store.byRun(w.runId)?.reviewRequest?.takenAt).not.toBeNull(), { timeout: 5_000 });
  w.store.release(w.runId);
  await vi.waitFor(() => expect(w.fake.pr(1).merged || gatePrompt(w) !== undefined).toBe(true), { timeout: 5_000 });
}

describe("an ask whose review escalates", () => {
  it("opens approve-merge, never merges, when the asked reviewers stay silent until the failed-rounds cap", async () => {
    const w = heldRun(G10_ADVERSARY, undefined, { say: (spawn, head) => (spawn === 0 ? block("MERGE", head) : undefined) });
    await vi.waitFor(() => expect(waitingToMerge(w) && w.spawned.length === 1).toBe(true), { timeout: 5_000 });

    await ask(w);
    await releasedAfterAsk(w);

    expect(w.fake.pr(1).merged).toBe(false);
    expect(gatePrompt(w)).toContain("failed-rounds");
  });

  it("opens approve-merge, never merges, when the asked FIX_FIRST is the run's sixth", async () => {
    const w = heldRun(G10_ADVERSARY, undefined, { say: (spawn, head) => block(spawn === 5 ? "MERGE" : "FIX_FIRST", head) });
    for (let fix = 1; fix <= 5; fix += 1) {
      await vi.waitFor(() => expect(w.spawned.length === fix && /^sh-held-wait/.test(w.host.runtime.status(w.runId)?.currentStep ?? "")).toBe(true), { timeout: 5_000 });
      w.fake.pushHead(1, fakeSha(`fix-${fix}`));
    }
    await vi.waitFor(() => expect(waitingToMerge(w) && w.spawned.length === 6).toBe(true), { timeout: 5_000 });

    expect(await ask(w)).toMatchObject({ ok: true, data: { head: fakeSha("fix-5"), requested: true } });
    await releasedAfterAsk(w);

    expect(w.fake.pr(1).merged).toBe(false);
    expect(gatePrompt(w)).toContain("fix-first-runaway");
  });
});

describe("shepherd review", () => {
  it("spawns a fresh reviewer of Shepherd's own at the head a held run already reviewed, once per head", async () => {
    const w = heldRun(G10_ADVERSARY);
    await vi.waitFor(() => expect(waitingToMerge(w) && w.spawned.length === 1).toBe(true), { timeout: 5_000 });

    const first = await ask(w);
    await vi.waitFor(() => expect(w.store.byRun(w.runId)?.reviewRequest?.takenAt).not.toBeNull(), { timeout: 5_000 });
    const repeat = await ask(w);
    w.store.release(w.runId);
    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(first).toEqual({ ok: true, data: { runId: w.runId, head: H1, requested: true } });
    expect(repeat).toEqual({ ok: true, data: { runId: w.runId, head: H1, requested: false } });
    expect(w.spawned).toHaveLength(2);
    expect(new Set(w.spawned).size).toBe(2);
    expect(resultsOf(w, "sh-review-intent")).toEqual([expect.objectContaining({ mode: "spawn" }), expect.objectContaining({ mode: "spawn", cause: { cause: "seat-request" } })]);
    expect(resultsOf(w, "sh-review-request")).toContainEqual({ requested: true });
  });

  it("spawns Shepherd's own reviewer when the hold's named reviewer would otherwise review the head", async () => {
    const w = heldRun(G10_REVIEW, SEAT_REVIEWER);
    w.store.requestReview(w.runId, H1);

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(w.spawned).toHaveLength(1);
    expect(resultsOf(w, "sh-review-intent")).toEqual([expect.objectContaining({ mode: "spawn", requested: true })]);
  });

  it("never lets Shepherd's own MERGE release a g10-review hold whose named reviewer has not answered", async () => {
    const w = heldRun(G10_REVIEW, SEAT_REVIEWER, { seatSilent: true });
    w.store.requestReview(w.runId, H1);

    await vi.waitFor(() => expect(waitingToMerge(w) && w.spawned.length === 1).toBe(true), { timeout: 5_000 });

    expect(results(w).filter((result) => result.stepId.startsWith("sh-g10-release")).map((result) => result.data?.["result"])).not.toContainEqual(expect.objectContaining({ released: true }));
    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: G10_REVIEW, holdSatisfied: null });
    expect(w.fake.pr(1).merged).toBe(false);
  });

  it("keeps a timed-out asked review's retry Shepherd's own, never the hold's named reviewer", async () => {
    const w = heldRun(G10_REVIEW, SEAT_REVIEWER, { seatSilent: true, say: (spawn, head) => (spawn < 1 ? undefined : block("MERGE", head)) });
    w.store.requestReview(w.runId, H1);

    await vi.waitFor(() => expect(waitingToMerge(w) && w.spawned.length === 2).toBe(true), { timeout: 5_000 });

    expect(resultsOf(w, "sh-review-intent")).toEqual([expect.objectContaining({ mode: "spawn", requested: true }), expect.objectContaining({ mode: "spawn", cause: { cause: "retry", reason: "timeout" } })]);
    expect(w.fake.pr(1).merged).toBe(false);
  });

  it("spawns a fresh reviewer for an ask instead of resuming the registration's standing reviewer", async () => {
    const w = heldRun(G10_ADVERSARY, undefined, { standing: true });
    w.store.requestReview(w.runId, H1);

    await vi.waitFor(() => expect(waitingToMerge(w)).toBe(true), { timeout: 5_000 });

    expect(w.resumed).toEqual([]);
    expect(resultsOf(w, "sh-review-intent")).toEqual([expect.objectContaining({ mode: "spawn", requested: true })]);
  });

  it("refuses the Version Packages run, whose release preflight stands in for a reviewer", async () => {
    const w = heldRun(G10_ADVERSARY, undefined, { branch: VERSION_PACKAGES_BRANCH });

    expect(await ask(w)).toMatchObject({ ok: false, code: 65, error: expect.stringContaining("Version Packages") });
    expect(w.store.byRun(w.runId)?.reviewRequest).toBeNull();
  });

  it("refuses a run that already ended", async () => {
    const w = heldRun(G10_ADVERSARY);
    await vi.waitFor(() => expect(waitingToMerge(w)).toBe(true), { timeout: 5_000 });
    w.host.runtime.cancel(w.runId, "operator stopped it");
    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.status).toBe("cancelled"), { timeout: 5_000 });

    expect(await ask(w)).toMatchObject({ ok: false, code: 65, error: expect.stringContaining("already ended") });
    expect(w.store.byRun(w.runId)?.reviewRequest).toBeNull();
  });
});
