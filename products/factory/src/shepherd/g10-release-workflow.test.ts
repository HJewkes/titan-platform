import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { openDatabase } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { G10_RELEASE_STEP, TWO_MERGE_RULE, type TwoMergeMode } from "./g10-release.js";
import { DEFAULT_ADVERSARY_PROFILE } from "./review-panel-plan.js";
import { supersedeMovedGates } from "./head-moved.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import type { Presence } from "./presence.js";
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage, ReviewerReader } from "@titan-design/review-panel";
import { reviewPhase } from "./review.js";
import type { ReviewerRoles } from "./reviewer-roles.js";
import type { RosterReader } from "./roster.js";
import { shepherdStoreRef, type ShepherdStore, type ShepherdStoreRef } from "./store.js";
import { fakeLocator } from "../test-support/fakes.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const G10_HOLD = "g10-review: auth change; TP-1";

const row = (name: string, presence: Presence = "exited"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null });
const said = (who: ReviewerAgent, text: string): ReviewerMessage => ({
  ...{ agentId: who.agentId, sessionId: who.sessionId, writtenAt: 1, text },
  locator: fakeLocator({ source: { conversation: { nativeId: who.sessionId } } }),
});

const STANDING = "rv-standing";

/** The broker's roster over the same agents; Shepherd spawns through the CLI, which the broker records as the human. */
function rosterOver(agents: readonly ReviewerAgent[]): RosterReader {
  const rows = (): AgentRow[] => agents.map((agent) => ({ ...agent, state: agent.presence, status: "finished", profile: agent.profile ?? "", surface: "headless", cwd: "/work", generation: 1 }));
  return { read: async () => ({ kind: "known", rows: rows() }), rows: async () => rows(), invalidate: () => undefined };
}

/** Every reviewer Shepherd spawns or resumes says MERGE at the head it reads; the standing reviewer has ended with room to resume. */
function mergingReviewers(): { dispatch: ReviewerDispatch; reader: ReviewerReader; roster: RosterReader } {
  const agents: ReviewerAgent[] = [{ ...row("coord", "live"), spawnedBy: null }, row("impl-a"), { ...row(STANDING), fillTokens: 1_000 }];
  const resume = async (name: string) => agents.forEach((agent, i) => agent.name === name && (agents[i] = { ...agent, presence: "live" }));
  const dispatch: ReviewerDispatch = { roster: async () => [...agents], spawn: async (name) => void agents.push({ ...row(name), spawnedBy: "human" }), resume };
  const reader: ReviewerReader = {
    read: async (input) => agents.filter((who) => who.agentId === input.reviewerAgentId).map((who) => said(who, `Read it all.\n\nProbes: an empty list -> refused\nVerdict: MERGE\nPR: ${REPO}#1\nHead: ${input.head}\n`)),
  };
  return { dispatch, reader, roster: rosterOver(agents) };
}

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStore;
  ref: ShepherdStoreRef;
  runId: string;
  services: NonNullable<ReturnType<typeof factoryRoutesFor>["shepherd"]>;
  reviewers: ReturnType<typeof mergingReviewers>;
}

interface Scene {
  policy?: EffectivePolicy;
  hold?: string;
  /** A head whose every review round ends with no verdict, as tp#1558's did before its fix push. */
  silentAt?: string;
  /** `shepherd.gateReset.twoMergeRelease`, as `workflows.ts` wires it: a g10-adversary hold's member and the release mode. */
  twoMerge?: TwoMergeMode;
  files?: string[];
  /** A head whose review ends with the PR conflicting, so the round leaves through the conflict route. */
  conflictsAfter?: string;
  dbPath?: string;
  /** The lineage roster cannot be read, so a two-MERGE release answers no. */
  rosterDown?: boolean;
  /** The reviewers a later deploy's host shares with the first, so the agents the first spawned stay on its roster. */
  reviewers?: ReturnType<typeof mergingReviewers>;
}

/** A security PR held as `g10-review`, reviewed for real by a reviewer spawned with the profile `roles` gives its class. */
function heldSecurityRun(roles: ReviewerRoles, policy: EffectivePolicy = AUTO_POLICY, hold = G10_HOLD): World {
  return heldRun(roles, { policy, hold });
}

/** One deploy's host over `fake` and `ref`; a second one on the same `dbPath` adopts what the first left in flight. */
function sceneHost(fake: FakeGitHub, ref: ShepherdStoreRef, roles: ReviewerRoles, { silentAt, twoMerge, conflictsAfter, dbPath = ":memory:", rosterDown, reviewers: shared = mergingReviewers() }: Scene) {
  const wake: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "no fixer in this test" });
  const adversary = twoMerge && { holdMember: { profile: DEFAULT_ADVERSARY_PROFILE }, twoMergeRelease: twoMerge };
  const { roster: up, ...reviewers } = shared;
  const roster: RosterReader = rosterDown ? { ...up, read: async () => ({ kind: "unknown", error: new Error("roster down") }) } : up;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), roster, review: { ...reviewers, roles, ...adversary } });
  const reviewed: ShepherdPhases["review"] = async (ctx, request) => (request.headSha === silentAt ? { kind: "none", cause: "no-verdict", reason: "no_block" } : reviewPhase(ctx, request));
  const review: ShepherdPhases["review"] = async (ctx, request) => {
    const verdict = await reviewed(ctx, request);
    if (request.headSha === conflictsAfter) fake.pr(1).mergeableState = "dirty";
    return verdict;
  };
  const host = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow({ review, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, routes };
}

function heldRun(roles: ReviewerRoles, scene: Scene): World {
  const { policy = AUTO_POLICY, hold = G10_HOLD, files = ["src/a.ts"] } = scene;
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const ref = shepherdStoreRef();
  const reviewers = scene.reviewers ?? mergingReviewers();
  const { host, routes } = sceneHost(fake, ref, roles, { ...scene, reviewers });
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, files.map((path) => ({ path, status: "modified" })));
  const store = ref.get();
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(policy) });
  store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy, kind: "security" });
  store.hold(runId, hold, undefined, { actor: "seat" });
  return { host, fake, store, ref, runId, services: routes.shepherd!, reviewers };
}

const stepIds = (w: World): string[] => Object.values(w.host.runtime.status(w.runId)!.stepResults).map((result) => result.stepId);
const reviewMode = (w: World, head = H1): unknown => Object.values(w.host.runtime.status(w.runId)!.stepResults).find((result) => result.stepId === `sh-review:${head}`)?.data?.["result"];

describe("a g10-review hold on a run Shepherd reviews itself", () => {
  it("releases itself on the spawned opus reviewer's MERGE at a green head, and the PR merges", async () => {
    const w = heldSecurityRun({ g10: "bd-reviewer", standard: "reviewer" });

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(stepIds(w)).toContain(`${G10_RELEASE_STEP}:${H1}:0`);
    expect(w.store.byRun(w.runId)?.held).toBe(false);
  });

  it("releases itself and merges the same way while a seat's repair stop covers the run (TP-3500)", async () => {
    const w = heldSecurityRun({ g10: "bd-reviewer", standard: "reviewer" });
    w.store.repairStops().set({ repo: REPO, scope: "#1" }, "the owner's freeze", { actor: "seat" });

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(stepIds(w)).toContain(`${G10_RELEASE_STEP}:${H1}:0`);
    expect(w.store.byRun(w.runId)?.held).toBe(false);
  });

  it.each([
    ["the spawned reviewer's profile is not an opus one", { g10: "reviewer", standard: "reviewer" }, AUTO_POLICY, "spawn"],
    ["the MERGE is a resumed standing reviewer's", { g10: "bd-reviewer", standard: "reviewer" }, { ...AUTO_POLICY, reviewer: STANDING }, "resume"],
  ] as const)("stays held when %s", async (_case, roles, policy, mode) => {
    const w = heldSecurityRun(roles, policy);

    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toBe("merge:0"), { timeout: 5_000 });

    expect(reviewMode(w)).toMatchObject({ kind: "dispatched", mode });
    expect(stepIds(w).filter((id) => id.startsWith(G10_RELEASE_STEP))).toEqual([]);
    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: G10_HOLD });
    expect(w.fake.pr(1).merged).toBe(false);
  });
});

describe("a hold no reviewer of Shepherd's releases, on a run waiting at merge whose head moves", () => {
  const H2 = fakeSha("g10-moved-h2");

  it.each([
    ["an owner's", "owner wants a look"],
    ["a g10-adversary", "g10-adversary: merge-policy change; TP-1"],
  ])("keeps %s hold through a fresh opus review and green CI at the new head, and merges neither head", async (_case, hold) => {
    const w = heldSecurityRun({ g10: "bd-reviewer", standard: "reviewer" }, AUTO_POLICY, hold);
    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toBe("merge:0"), { timeout: 5_000 });

    w.fake.pushHead(1, H2);

    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toBe("merge:1"), { timeout: 5_000 });
    expect(reviewMode(w, H2)).toMatchObject({ kind: "dispatched" });
    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: hold });
    expect(w.fake.calls).not.toContain("merge");
    expect(w.fake.pr(1).merged).toBe(false);
  });
});

describe("a g10-adversary hold under gateReset.twoMergeRelease (decision 422(1))", () => {
  const ADVERSARY_HOLD = "g10-adversary: policy touch";
  const opus = { g10: "bd-reviewer", standard: "reviewer" } as const;
  const releaseResult = (w: World): unknown => Object.values(w.host.runtime.status(w.runId)!.stepResults).find((result) => result.stepId.startsWith(G10_RELEASE_STEP))?.data?.["result"];

  it("releases on Shepherd's correctness and adversary MERGEs at a green head, with no seat, and the PR merges", async () => {
    const w = heldRun(opus, { hold: ADVERSARY_HOLD, twoMerge: "on" });

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(stepIds(w)).toContain(`sh-await-verdict:${H1}:adversary`);
    expect(releaseResult(w)).toMatchObject({ released: true, rule: TWO_MERGE_RULE, correctness: { profile: "bd-reviewer" }, adversary: { profile: DEFAULT_ADVERSARY_PROFILE } });
    expect(w.store.eventsOf(w.runId).at(-1)).toMatchObject({ kind: "release", actor: "shepherd", headSha: H1 });
  });

  it("releases on both MERGEs before a conflict read after the review leaves the round (TP-3198 cause E)", async () => {
    const w = heldRun(opus, { hold: ADVERSARY_HOLD, twoMerge: "on", conflictsAfter: H1 });

    await vi.waitFor(() => expect(w.store.byRun(w.runId)?.held).toBe(false), { timeout: 5_000 });

    expect(releaseResult(w)).toMatchObject({ released: true, rule: TWO_MERGE_RULE, correctness: { profile: "bd-reviewer" }, adversary: { profile: DEFAULT_ADVERSARY_PROFILE } });
    expect(w.fake.pr(1).merged).toBe(false);
  });

  it.each([
    ["under shadow, recording that it would release", { twoMerge: "shadow" as const }, { released: false, wouldRelease: true }],
    ["when the diff changes the owner's rule file", { twoMerge: "on" as const, files: ["src/a.ts", "packages/authority/src/table.json"] }, { released: false }],
  ])("stays held %s, and merges nothing", async (_case, scene, result) => {
    const w = heldRun(opus, { hold: ADVERSARY_HOLD, ...scene });

    await vi.waitFor(() => expect(releaseResult(w)).toMatchObject(result), { timeout: 5_000 });
    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toBe("merge:0"), { timeout: 5_000 });

    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: ADVERSARY_HOLD });
    expect(w.fake.pr(1).merged).toBe(false);
  });
});

const OPUS = { g10: "bd-reviewer", standard: "reviewer" } as const;
const pendingApproveMerge = (w: World) => w.host.pendingGates().filter((pending) => pending.runId === w.runId && pending.stepId === "approve-merge");

describe("tp#1558: a failed-rounds owner gate whose head a fix push moves (TP-3083)", () => {
  const H2 = fakeSha("tp1558-fix-push");

  it("asks the owner again at the new head after Shepherd's own opus MERGE there, and merges nothing", async () => {
    const w = heldRun(OPUS, { silentAt: H1 });
    await gateOpened(w.host, gateId(w.runId, "approve-merge"));
    expect(w.host.gates.get(gateId(w.runId, "approve-merge"))?.prompt).toContain(`at head ${H1} into main? CI is green. Policy shepherd-route/failed-rounds`);

    w.fake.pushHead(1, H2);
    await supersedeMovedGates(w.host, w.services);
    await gateOpened(w.host, gateId(w.runId, "approve-merge", 1));

    expect(w.host.gates.get(gateId(w.runId, "approve-merge"))?.status).toBe("cancelled");
    expect(pendingApproveMerge(w).map((pending) => pending.gate.prompt)).toEqual([expect.stringContaining(`at head ${H2} into main? CI is green. Policy shepherd-route/failed-rounds`)]);
    expect(w.fake.calls).not.toContain("merge");
    expect(w.fake.pr(1).merged).toBe(false);
  });
});

describe("a review the owner assigned to a person (TP-3083)", () => {
  it("keeps an owner-review hold through Shepherd's own opus MERGE at a green head, and merges nothing", async () => {
    const hold = "owner-review: assigned to a seat reviewer";
    const w = heldRun(OPUS, { hold });

    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toBe("merge:0"), { timeout: 5_000 });

    expect(reviewMode(w)).toMatchObject({ kind: "dispatched" });
    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: hold });
    expect(w.store.eventsOf(w.runId).filter((event) => event.kind === "release")).toEqual([]);
    expect(w.fake.pr(1).merged).toBe(false);
  });
});

const StoredStepResults = z.record(z.string(), z.object({ stepId: z.string() }).loose());

/** Rewrites a stored run's step results in recording order; returns the rewritten keys. */
function rewriteRecord(dbPath: string, runId: string, edit: (keys: string[]) => string[]): string[] {
  const db = openDatabase(dbPath);
  const row = z.object({ step_results: z.string() }).parse(db.prepare("SELECT step_results FROM workflow_run WHERE id = ?").get(runId));
  const results = StoredStepResults.parse(JSON.parse(row.step_results));
  const keys = edit(Object.keys(results));
  db.prepare("UPDATE workflow_run SET step_results = ? WHERE id = ?").run(JSON.stringify(Object.fromEntries(keys.map((key) => [key, results[key]]))), runId);
  db.close();
  return keys;
}

const recordedKeys = (host: FactoryHost, runId: string): string[] => Object.keys(host.runtime.status(runId)!.stepResults);
const isReleaseKey = (key: string): boolean => key.startsWith(`${G10_RELEASE_STEP}:`);

describe("a g10-adversary run recorded with an adversary member MERGE and adopted by the next build", () => {
  const ADVERSARY_HOLD = "g10-adversary: authority touch";

  /** A run under shadow that reached merge:0 held, its host closed as a deploy closes it. */
  async function inFlightAtMerge(): Promise<World & { dbPath: string }> {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp-g10-replay-")), "factory.db");
    const w = heldRun(OPUS, { hold: ADVERSARY_HOLD, twoMerge: "shadow", dbPath });
    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toBe("merge:0"), { timeout: 5_000 });
    w.host.close();
    return { ...w, dbPath };
  }

  /** Adopts the run on a new host and waits until it parks or its replay reaches the frontier, where the live merge step reads the PR. */
  async function adoptedBy(w: World & { dbPath: string }): Promise<FactoryHost> {
    const { host } = sceneHost(w.fake, w.ref, OPUS, { twoMerge: "shadow", dbPath: w.dbPath });
    const callsBefore = w.fake.calls.length;
    await host.adopt();
    await vi.waitFor(() => expect(host.runtime.status(w.runId)?.status === "recovery_required" || w.fake.calls.length > callsBefore).toBe(true), { timeout: 5_000 });
    return host;
  }

  it("replays a record from before the two-MERGE ask as it ran: no live release step, no divergence", async () => {
    const w = await inFlightAtMerge();
    const legacy = rewriteRecord(w.dbPath, w.runId, (keys) => keys.filter((key) => !isReleaseKey(key)));
    const policyAt = legacy.indexOf("sh-policy:0:0");
    expect(legacy).toContain(`sh-await-verdict:${H1}:adversary:0`);
    expect(legacy.slice(policyAt, policyAt + 2)).toEqual(["sh-policy:0:0", "base-check:0:0"]);

    const second = await adoptedBy(w);

    expect(second.runtime.status(w.runId)?.error).toBeNull();
    expect(second.runtime.status(w.runId)?.status).toBe("running");
    expect(recordedKeys(second, w.runId)).toEqual(legacy);
  });

  it("replays a record that asked the release step, reading the recorded answer", async () => {
    const w = await inFlightAtMerge();
    const recorded = rewriteRecord(w.dbPath, w.runId, (keys) => keys);
    expect(recorded).toContain(`${G10_RELEASE_STEP}:${H1}:0:0`);

    const second = await adoptedBy(w);

    expect(second.runtime.status(w.runId)?.status).toBe("running");
    expect(recordedKeys(second, w.runId)).toEqual(recorded);
  });

  it("asks the release step live at the frontier of a fresh run", async () => {
    const w = heldRun(OPUS, { hold: ADVERSARY_HOLD, twoMerge: "shadow" });

    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toBe("merge:0"), { timeout: 5_000 });

    const keys = recordedKeys(w.host, w.runId);
    expect(keys.indexOf(`${G10_RELEASE_STEP}:${H1}:0:0`)).toBe(keys.indexOf("sh-policy:0:0") + 1);
  });
});

describe("a g10-adversary run whose release step answered no before a deploy, waiting on the hold at merge (TP-3956)", () => {
  const ADVERSARY_HOLD = "g10-adversary: authority touch";
  const releaseResults = (host: FactoryHost, runId: string): unknown[] =>
    Object.entries(host.runtime.status(runId)!.stepResults).filter(([key]) => isReleaseKey(key)).map(([, result]) => result.data?.["result"]);

  /** A run whose two-MERGE release answered no, waiting held at merge:0 when its host closes as a deploy closes it. */
  async function refusedAtMerge(): Promise<World & { dbPath: string; refusals: unknown[] }> {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp-g10-recheck-")), "factory.db");
    const w = heldRun(OPUS, { hold: ADVERSARY_HOLD, twoMerge: "on", rosterDown: true, dbPath });
    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toBe("merge:0"), { timeout: 5_000 });
    const refusals = releaseResults(w.host, w.runId);
    expect(refusals).toContainEqual(expect.objectContaining({ released: false }));
    expect(refusals).not.toContainEqual(expect.objectContaining({ released: true }));
    w.host.close();
    return { ...w, dbPath, refusals };
  }

  it("asks the release again under the next build, which releases the hold, and the PR merges", async () => {
    const w = await refusedAtMerge();
    const { host } = sceneHost(w.fake, w.ref, OPUS, { twoMerge: "on", dbPath: w.dbPath, reviewers: w.reviewers });

    await host.adopt();

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });
    expect(releaseResults(host, w.runId)).toEqual([...w.refusals, expect.objectContaining({ released: true, rule: TWO_MERGE_RULE })]);
    expect(w.ref.get().eventsOf(w.runId).filter((event) => event.kind === "release")).toEqual([expect.objectContaining({ actor: "shepherd", headSha: H1 })]);
  });

  it("asks once more when the next build still answers no, then waits held at merge without asking again", async () => {
    const w = await refusedAtMerge();
    const { host } = sceneHost(w.fake, w.ref, OPUS, { twoMerge: "on", rosterDown: true, dbPath: w.dbPath, reviewers: w.reviewers });

    await host.adopt();

    await vi.waitFor(() => expect(host.runtime.status(w.runId)?.currentStep).toBe("merge:1"), { timeout: 5_000 });
    const polled = w.fake.calls.length;
    await vi.waitFor(() => expect(w.fake.calls.length).toBeGreaterThan(polled + 40), { timeout: 5_000 });
    expect(host.runtime.status(w.runId)?.currentStep).toBe("merge:1");
    expect(releaseResults(host, w.runId)).toEqual([...w.refusals, expect.objectContaining({ released: false })]);
    expect(w.ref.get().byRun(w.runId)).toMatchObject({ held: true, holdReason: ADVERSARY_HOLD });
    expect(w.fake.pr(1).merged).toBe(false);
  });
});
