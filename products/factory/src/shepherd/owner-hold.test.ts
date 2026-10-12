import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { callCommand, shepherdFixture } from "../test-support/shepherd.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { runCleanup } from "./cleanup.js";
import { shepherdEventMigration } from "./events.js";
import { G10_RELEASE_STEP } from "./g10-release.js";
import { MergeHeldError, holdingPort } from "./hold.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import type { Presence } from "./presence.js";
import { reviewPhase, type ReviewerAgent, type ReviewerDispatch, type ReviewerMessage, type ReviewerReader } from "./review.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, holdSlotsMigration, lineageMigration, ownerHoldMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const OWNER = "owner-asked: discuss scope; tp#1027";
const G10 = "g10-review: auth change";
const ADVERSARY = "g10-adversary: merge-policy change";
const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };

const row = (name: string, presence: Presence = "exited"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null });
const locatorOf = (sessionId: string): SourceTextLocator => ({
  source: {
    sourceId: `transcript-${sessionId}`,
    harness: "claude-code",
    format: "jsonl",
    formatVersion: null,
    path: `/transcripts/${sessionId}.jsonl`,
    namespace: "test",
    conversation: { harness: "claude-code", namespace: "test", nativeId: sessionId },
    provenance: { kind: "native", name: "test" },
  },
  evidence: {
    line: { sourceId: `transcript-${sessionId}`, byteOffset: 0, byteLength: 1, contentHash: "0".repeat(64), lineNumber: 1, nativeOrdinal: null },
    subrecord: { index: 0, path: [] },
  },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
});

const said = (who: ReviewerAgent, text: string): ReviewerMessage => ({ agentId: who.agentId, sessionId: who.sessionId, writtenAt: 1, text, locator: locatorOf(who.sessionId) });

/** Every reviewer Shepherd spawns says MERGE at the head it reads, as Shepherd's opus reviewer did on tp#1027. */
function mergingReviewers(): { dispatch: ReviewerDispatch; reader: ReviewerReader } {
  const agents: ReviewerAgent[] = [{ ...row("coord", "live"), spawnedBy: null }, row("impl-a")];
  const dispatch: ReviewerDispatch = { roster: async () => [...agents], spawn: async (name) => void agents.push(row(name)), resume: async () => undefined };
  const reader: ReviewerReader = {
    read: async (input) => agents.filter((who) => who.agentId === input.reviewerAgentId).map((who) => said(who, `Read it all.\n\nVerdict: MERGE\nPR: ${REPO}#1\nHead: ${input.head}\n`)),
  };
  return { dispatch, reader };
}

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStore;
  runId: string;
}

/** A security PR at green checks, held by the owner and then by the seat's `g10-review`, with Shepherd's opus reviewer saying MERGE. */
function tp1027(): World {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const wake: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "no fixer in this test" });
  const ref = shepherdStoreRef();
  const roles = { g10: "bd-reviewer", standard: "reviewer" };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), review: { ...mergingReviewers(), roles } });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const store = ref.get();
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
  store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO_POLICY, kind: "security" });
  store.hold(runId, OWNER, undefined, { actor: "owner" });
  store.hold(runId, G10, undefined, { actor: "seat" });
  return { host, fake, store, runId };
}

const g10Release = (w: World): unknown =>
  Object.values(w.host.runtime.status(w.runId)!.stepResults).find((result) => result.stepId.startsWith(G10_RELEASE_STEP))?.data?.["result"];

describe("tp#1027 replayed: owner hold, g10-review hold, Shepherd's opus MERGE at a green head", () => {
  it("lets sh-g10-release lift only the g10-review hold, keeps the PR held for the owner, and refuses the merge", async () => {
    const w = tp1027();

    await vi.waitFor(() => expect(g10Release(w)).toMatchObject({ released: true, head: H1 }), { timeout: 5_000 });

    expect(w.store.heldReason(REPO, 1, undefined, H1)).toBe(OWNER);
    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: OWNER, ownerHold: { reason: OWNER } });
    await expect(holdingPort(githubPort(w.fake.wire), () => w.store).merge(REPO, 1, H1, "squash")).rejects.toThrow(MergeHeldError);
    expect(w.fake.pr(1).merged).toBe(false);
  });

  it("merges once the owner releases the hold", async () => {
    const w = tp1027();
    await vi.waitFor(() => expect(g10Release(w)).toMatchObject({ released: true }), { timeout: 5_000 });

    expect(w.store.releaseOwnerHold(w.runId, { actor: "owner-terminal:test", headSha: H1 })).toBe(true);

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });
    expect(w.store.eventsOf(w.runId).at(-1)).toMatchObject({ kind: "release", reason: OWNER, actor: "owner-terminal:test" });
  });
});

const MIGRATIONS_TO_19 = [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)];

function storeAt(): { db: Db; store: ShepherdStore } {
  const db = openDatabase(":memory:");
  runMigrations(db, [...MIGRATIONS_TO_19, ownerHoldMigration(22)]);
  const store = new ShepherdStore(db, () => 0);
  store.register({ repo: REPO, pr: 1, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return { db, store };
}

const satisfy = (store: ShepherdStore, reviewer: string, head = H1): boolean => store.satisfyHold("run-1", reviewer, head, { agentId: `agent-${reviewer}`, sessionId: `session-${reviewer}`, locator: {} });

describe("an owner-asked hold in its own slot", () => {
  it.each([
    ["a g10-review hold", G10],
    ["a g10-adversary hold", ADVERSARY],
  ])("stays set under %s placed after it, and after that hold's release", (_case, other) => {
    const { store } = storeAt();
    store.hold("run-1", OWNER);

    store.hold("run-1", other);
    const under = store.byRun("run-1");
    store.release("run-1");

    expect(under).toMatchObject({ holdReason: other, ownerHold: { reason: OWNER } });
    expect(store.byRun("run-1")).toMatchObject({ held: true, holdReason: OWNER, ownerHold: { reason: OWNER } });
  });

  it("is left by releaseIfHeld and releaseClass, named or bare", () => {
    const { store } = storeAt();
    store.hold("run-1", G10);
    store.hold("run-1", OWNER);

    const ifHeld = store.releaseIfHeld("run-1", OWNER);
    const named = store.releaseClass("run-1", "owner-asked");
    const g10 = store.releaseIfHeld("run-1", G10);
    const bare = store.releaseClass("run-1", undefined);

    expect({ ifHeld, named, g10, bare }).toEqual({ ifHeld: false, named: false, g10: true, bare: false });
    expect(store.heldReason(REPO, 1)).toBe(OWNER);
  });

  it("holds a merge at the head the reviewer hold was satisfied at", () => {
    const { store } = storeAt();
    store.hold("run-1", OWNER);
    store.hold("run-1", G10, "rv-sec");

    const recorded = satisfy(store, "rv-sec");

    expect(recorded).toBe(true);
    expect(store.byRun("run-1")?.holdSatisfied?.head).toBe(H1);
    expect(store.heldReason(REPO, 1, undefined, H1)).toBe(OWNER);
  });

  it("refuses a reviewer at the store, writing nothing", () => {
    const { store } = storeAt();

    expect(() => store.hold("run-1", OWNER, "rv-sec")).toThrow(/no reviewer/);
    expect(store.byRun("run-1")).toMatchObject({ held: false, ownerHold: null });
    expect(store.eventsOf("run-1")).toEqual([]);
  });

  it("keeps when it was first placed across a repeat, and records when the owner was asked again", () => {
    let now = 0;
    const db = openDatabase(":memory:");
    runMigrations(db, [...MIGRATIONS_TO_19, ownerHoldMigration(22)]);
    const store = new ShepherdStore(db, () => now);
    store.register({ repo: REPO, pr: 1, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    store.hold("run-1", OWNER);
    now = 60_000;

    store.hold("run-1", "owner-asked: still discussing");
    const asked = store.markOwnerAsked("run-1");

    expect(asked).toBe(true);
    expect(store.byRun("run-1")?.ownerHold).toEqual({ reason: "owner-asked: still discussing", at: new Date(0).toISOString(), askedAt: new Date(60_000).toISOString() });
  });

  it("is lifted by releaseOwnerHold alone, once", () => {
    const { store } = storeAt();
    store.hold("run-1", OWNER);

    const first = store.releaseOwnerHold("run-1", { actor: "owner-terminal:test" });
    const second = store.releaseOwnerHold("run-1", { actor: "owner-terminal:test" });

    expect({ first, second }).toEqual({ first: true, second: false });
    expect(store.byRun("run-1")).toMatchObject({ held: false, holdReason: null, ownerHold: null });
    expect(store.markOwnerAsked("run-1")).toBe(false);
    expect(store.eventsOf("run-1").map((event) => [event.kind, event.reason, event.actor])).toEqual([
      ["hold", OWNER, "shepherd"],
      ["release", OWNER, "owner-terminal:test"],
    ]);
  });
});

describe("the owner-hold migration", () => {
  it("opens a store already at version 19 with a held row, and the row keeps its hold", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, MIGRATIONS_TO_19);
    const before = new ShepherdStore(db);
    before.register({ repo: REPO, pr: 1, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    before.hold("run-1", G10, "rv-sec");

    const applied = runMigrations(db, [...MIGRATIONS_TO_19, ownerHoldMigration(22)]);

    expect(applied).toEqual([22]);
    expect(new ShepherdStore(db).byRun("run-1")).toMatchObject({ held: true, holdReason: G10, holdReviewer: "rv-sec", ownerHold: null });
  });

  it("changes nothing when its columns are already there", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [...MIGRATIONS_TO_19, ownerHoldMigration(22)]);

    expect(() => ownerHoldMigration(22).up(db)).not.toThrow();
  });
});

describe("shepherd hold and release on an owner-asked hold", () => {
  function world() {
    const fixture = shepherdFixture({ frozen: true });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
    hosts.push(host);
    fixture.fake.addPr({ headSha: H1 });
    const store = fixture.routes.shepherd!.store.get();
    store.register({ repo: REPO, pr: 1, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    return { store, call: (name: string, args: unknown) => callCommand(host, fixture.routes, name, args) };
  }

  it("refuses --class owner-asked as an argument, exit 65, and keeps the hold", async () => {
    const w = world();
    w.store.hold("run-1", OWNER);

    const refused = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1, holdClass: "owner-asked" });

    expect(refused).toMatchObject({ ok: false, code: 65, error: expect.stringContaining("Invalid arguments: holdClass") });
    expect(w.store.byRun("run-1")?.ownerHold).toMatchObject({ reason: OWNER });
  });

  it("refuses a bare release of a run held by the owner alone, naming the owner's release", async () => {
    const w = world();
    w.store.hold("run-1", OWNER);

    const refused = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1 });

    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("only the owner releases an owner-asked hold") });
    expect(w.store.eventsOf("run-1")).toHaveLength(1);
  });

  it("lifts only the other hold on a bare release, and answers that the owner's still holds", async () => {
    const w = world();
    w.store.hold("run-1", OWNER);
    w.store.hold("run-1", G10);

    const released = await w.call("shepherd.release", { repo: REPO, pr: 1, head: H1 });

    expect(released).toEqual({ ok: true, data: { runId: "run-1", held: { reason: OWNER } } });
  });

  it("refuses an owner-asked hold that names a reviewer, exit 65, holding nothing", async () => {
    const w = world();

    const refused = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: OWNER, reviewer: "rv-sec" });

    expect(refused).toMatchObject({ ok: false, code: 65, error: expect.stringContaining("--reviewer") });
    expect(w.store.byRun("run-1")?.held).toBe(false);
  });

  it("holds an owner-asked reason with no task cited", async () => {
    const w = world();

    const held = await w.call("shepherd.hold", { repo: REPO, pr: 1, reason: "owner-asked: hold, discuss" });

    expect(held).toEqual({ ok: true, data: { runId: "run-1", held: { reason: "owner-asked: hold, discuss" } } });
  });
});

describe("sh-cleanup on a PR merged with an owner hold in force", () => {
  it("clears the owner slot and the other hold, with an event that says the hold was bypassed", async () => {
    const { store } = storeAt();
    store.hold("run-1", OWNER);
    store.hold("run-1", G10);
    const fake = fakeGitHub({ repo: REPO });
    fake.addPr({ headRef: "feat/x", headSha: H1, state: "closed", merged: true, mergeSha: fakeSha("merge") });
    const deps = { port: githubPort(fake.wire), store: { get: () => store, bind: () => () => undefined }, now: () => 0, sleep: async () => undefined, pollMs: 1 };

    await runCleanup(deps, { repo: REPO, pr: 1, runId: "run-1" }, new AbortController().signal);

    expect(store.byRun("run-1")).toMatchObject({ held: false, ownerHold: null });
    const releases = store.eventsOf("run-1").filter((event) => event.kind === "release");
    expect(releases.map((event) => event.reason)).toEqual([`owner hold bypassed: merged outside Shepherd (${OWNER})`, G10]);
  });
});
