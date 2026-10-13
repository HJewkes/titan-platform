import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { holdSlotsMigration, parkSettledMigration } from "./store-migrations.js";
import { adversaryRehold } from "./adversary-anchor.js";
import { adversaryGuard } from "./adversary-guard.js";
import { accountLimitMigration } from "./account-store.js";
import { reclassMarkMigration, shepherdEventMigration } from "./events.js";
import { MergeHeldError, holdingPort } from "./hold.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { releaseAtHead } from "./release-head.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";
import type { CarryInput, CarryResult } from "./tree-carry.js";

const REPO = "octo/demo";
const REVIEWED = fakeSha("reviewed");
const MOVED = fakeSha("moved");
const MAIN = fakeSha("main-tip");
const TREE = fakeSha("merge-tree");
const ADVERSARY = "g10-adversary: trust rule (security); TP-1";
const STALL = "stalled: no progress; TP-2";

const FIX_PUSH: CarryResult = { equal: true, base: MAIN, firstParent: REVIEWED, headTree: fakeSha("tree-with-fix"), mergeTree: TREE };
const CLEAN_MERGE_UP: CarryResult = { equal: true, base: MAIN, firstParent: REVIEWED, headTree: TREE, mergeTree: TREE };

interface Rig {
  fake: FakeGitHub;
  store: ShepherdStore;
  guard: ReturnType<typeof adversaryGuard>;
  merge: () => Promise<unknown>;
}

/** A run whose seat released a g10-adversary hold at REVIEWED, then held and lifted a stall at MOVED, where the PR now is. */
function rig(probe: (input: CarryInput) => Promise<CarryResult>, head = MOVED): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  fake.addPr({ headSha: head });
  store.register({ repo: REPO, pr: 1, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  store.hold("run-1", ADVERSARY, undefined, { actor: "seat" });
  store.release("run-1", { actor: "seat", headSha: REVIEWED });
  store.hold("run-1", STALL, undefined, { actor: "seat" });
  store.release("run-1", { actor: "seat", headSha: head });
  const guard = adversaryGuard({ store: () => store, carry: probe });
  const port = holdingPort(githubPort(fake.wire), () => store, guard);
  return { fake, store, guard, merge: () => port.merge(REPO, 1, head, "squash") };
}

describe("the merge guard after a seat released a g10-adversary hold", () => {
  it("refuses a head where the seat lifted only a stall, re-holds it, and ends one merge wait", async () => {
    const r = rig(async () => FIX_PUSH);

    await expect(r.merge()).rejects.toBeInstanceOf(MergeHeldError);

    expect(r.fake.pr(1).merged).toBe(false);
    expect(r.store.byRun("run-1")?.holdReason).toContain(`from ${REVIEWED} to ${MOVED}`);
    expect(r.store.eventsOf("run-1").at(-1)).toMatchObject({ kind: "hold", actor: "shepherd", headSha: MOVED });
    expect([r.guard.takeRehold(REPO, 1), r.guard.takeRehold(REPO, 1)]).toEqual([true, false]);
  });

  it("re-holds when the probe fails", async () => {
    const r = rig(async () => {
      throw new Error("git fetch failed");
    });

    await expect(r.merge()).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.store.byRun("run-1")?.held).toBe(true);
  });

  it("lets a clean merge-up of the released head merge, and probes it once", async () => {
    let probes = 0;
    const r = rig(async () => (probes++, CLEAN_MERGE_UP));

    await r.merge();

    expect(r.fake.pr(1).merged).toBe(true);
    expect(r.store.byRun("run-1")?.held).toBe(false);
    await r.guard.reason(githubPort(r.fake.wire), REPO, 1, "main", MOVED);
    expect(probes).toBe(1);
  });

  it("lets the released head merge without a probe", async () => {
    const r = rig(async () => {
      throw new Error("the released head needs no probe");
    }, REVIEWED);

    await r.merge();

    expect(r.fake.pr(1).merged).toBe(true);
  });

  it("still refuses when a hold or release lands during the probe, and re-holds at the next check", async () => {
    let first = true;
    const r = rig(async () => {
      if (first) r.store.release("run-1", { actor: "seat", headSha: MOVED });
      first = false;
      return FIX_PUSH;
    });

    await expect(r.merge()).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.store.byRun("run-1")?.held).toBe(false);
    expect(r.guard.takeRehold(REPO, 1)).toBe(false);

    await expect(r.merge()).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.store.byRun("run-1")?.holdReason).toContain(`from ${REVIEWED} to ${MOVED}`);
  });

  it("lets the second of two consecutive clean merge-ups of the released head merge", async () => {
    const second = fakeSha("second-merge-up");
    const r = rig(async ({ head }) => (head === MOVED ? CLEAN_MERGE_UP : { ...CLEAN_MERGE_UP, firstParent: MOVED }), second);

    const first = await r.guard.reason(githubPort(r.fake.wire), REPO, 1, "main", MOVED);
    await r.merge();

    expect(first).toBeUndefined();
    expect(r.fake.pr(1).merged).toBe(true);
    expect(r.store.byRun("run-1")?.held).toBe(false);
  });

  it("refuses a merge-up whose first parent is a head nobody proved, even when its tree is clean", async () => {
    const r = rig(async () => ({ ...CLEAN_MERGE_UP, firstParent: fakeSha("unproven") }));

    await expect(r.merge()).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.store.byRun("run-1")?.holdReason).toContain(`from ${REVIEWED} to ${MOVED}`);
  });

  it("re-holds a run registered only by its branch, still waiting for its PR", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)]);
    const store = new ShepherdStore(db);
    const fake = fakeGitHub({ repo: REPO });
    const { headRef } = fake.addPr({ headSha: MOVED });
    store.register({ repo: REPO, branch: headRef, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    store.hold("run-1", ADVERSARY, undefined, { actor: "seat" });
    store.release("run-1", { actor: "seat", headSha: REVIEWED });
    const port = holdingPort(githubPort(fake.wire), () => store, adversaryGuard({ store: () => store, carry: async () => FIX_PUSH }));

    await expect(port.merge(REPO, 1, MOVED, "squash")).rejects.toBeInstanceOf(MergeHeldError);
    expect(fake.pr(1).merged).toBe(false);
    expect(store.byRun("run-1")?.holdReason).toContain(`from ${REVIEWED} to ${MOVED}`);
  });

  it("passes a run that never had a g10-adversary release", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)]);
    const store = new ShepherdStore(db);
    store.register({ repo: REPO, pr: 1, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    store.hold("run-1", STALL);
    store.release("run-1", { headSha: MOVED });
    const guard = adversaryGuard({ store: () => store, carry: async () => FIX_PUSH });

    expect(await guard.reason(githubPort(fakeGitHub({ repo: REPO }).wire), REPO, 1, "main", MOVED)).toBeUndefined();
  });
});

describe("the merge guard failing closed on a g10-adversary run", () => {
  /** A bare run on PR 1, at `head`, whose probe answers by base branch and counts its calls. */
  function bare(head = MOVED, answer: (input: CarryInput) => CarryResult = () => FIX_PUSH) {
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), accountLimitMigration(17), holdSlotsMigration(19), parkSettledMigration(21)]);
    const store = new ShepherdStore(db);
    const fake = fakeGitHub({ repo: REPO });
    fake.addPr({ headSha: head });
    store.register({ repo: REPO, pr: 1, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    const probes: CarryInput[] = [];
    const guard = adversaryGuard({ store: () => store, carry: async (input) => (probes.push(input), answer(input)) });
    const port = holdingPort(githubPort(fake.wire), () => store, guard);
    return { db, store, fake, guard, probes, merge: () => port.merge(REPO, 1, head, "squash") };
  }

  it("keeps the released line across a repoint, so the replacing run still re-holds a fix push", async () => {
    const r = bare();
    r.store.hold("run-1", ADVERSARY, undefined, { actor: "seat" });
    r.store.release("run-1", { actor: "seat", headSha: REVIEWED });

    r.store.repoint("run-1", "run-2");

    await expect(r.merge()).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.probes).toHaveLength(1);
    expect(r.store.byRun("run-2")?.holdReason).toContain(`from ${REVIEWED} to ${MOVED}`);
  });

  it("re-holds when legacy history let a hold of another class overwrite an unreleased adversary hold", async () => {
    const r = bare();
    r.store.hold("run-1", ADVERSARY, undefined, { actor: "seat" });
    r.db.prepare("INSERT INTO shepherd_event (run_id, repo, pr, kind, reason, actor, at) VALUES ('run-1', ?, 1, 'hold', ?, 'owner', '2026-01-01T00:00:00Z')").run(REPO, STALL);
    r.db.prepare("UPDATE shepherd_registration SET hold_reason = ? WHERE run_id = 'run-1'").run(STALL);

    r.store.release("run-1", { actor: "owner", headSha: MOVED });

    await expect(r.merge()).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.fake.pr(1).merged).toBe(false);
  });

  it("re-holds a code push after the seat released an adversary hold placed before hold events were recorded", async () => {
    const r = bare();
    r.store.hold("run-1", ADVERSARY, undefined, { actor: "seat" });
    r.db.prepare("DELETE FROM shepherd_event WHERE run_id = 'run-1'").run();

    expect(r.store.releaseClass("run-1", "g10-adversary", { actor: "seat", headSha: REVIEWED })).toBe(true);

    await expect(r.merge()).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.fake.pr(1).merged).toBe(false);
    expect(r.store.byRun("run-1")?.holdReason).toContain(`from ${REVIEWED} to ${MOVED}`);
  });

  it("re-holds after an adversary release that named no head", async () => {
    const r = bare(REVIEWED);
    r.store.hold("run-1", ADVERSARY, undefined, { actor: "seat" });

    r.store.release("run-1", { actor: "seat" });

    await expect(r.merge()).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.store.byRun("run-1")?.holdReason).toContain(`covers ${REVIEWED}`);
  });

  it("probes again on main a head proven clean only onto another base branch, and re-holds a fix push there", async () => {
    const r = bare(MOVED, ({ baseRef }) => (baseRef === "evil" ? CLEAN_MERGE_UP : FIX_PUSH));
    r.store.hold("run-1", ADVERSARY, undefined, { actor: "seat" });
    r.store.release("run-1", { actor: "seat", headSha: REVIEWED });

    const onEvil = await r.guard.reason(githubPort(r.fake.wire), REPO, 1, "evil", MOVED);

    expect(onEvil).toBeUndefined();
    await expect(r.merge()).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.probes.map((probe) => probe.baseRef)).toEqual(["evil", "main"]);
  });

  it("does not read a finished run on the same branch as the run of another PR", async () => {
    const r = bare();
    const { headRef } = r.fake.pr(1);
    r.db.prepare("DELETE FROM shepherd_registration WHERE run_id = 'run-1'").run();
    r.store.register({ repo: REPO, pr: 9, branch: headRef, runId: "run-9", task: "demo/9", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    r.store.hold("run-9", ADVERSARY, undefined, { actor: "seat" });
    r.store.release("run-9", { actor: "seat", headSha: REVIEWED });

    await r.merge();

    expect(r.fake.pr(1).merged).toBe(true);
  });
});

describe("an unread-files hold Shepherd re-classed", () => {
  const UNREAD = "g10-adversary: changed files unread at registration (GhError)";

  /** The run held unread at REVIEWED, lifted by `lift` there, and the PR then pushed to MOVED. */
  async function heldUnread(lift: (store: ShepherdStore, port: GitHubPort) => Promise<unknown>) {
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), reclassMarkMigration(25)]);
    const store = new ShepherdStore(db);
    const fake = fakeGitHub({ repo: REPO });
    fake.addPr({ headSha: REVIEWED });
    store.register({ repo: REPO, pr: 1, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    store.hold("run-1", UNREAD, undefined, { actor: "shepherd", headSha: REVIEWED });
    await lift(store, githubPort(fake.wire));
    fake.pushHead(1, MOVED);
    const guard = adversaryGuard({ store: () => store, carry: async () => FIX_PUSH });
    const port = holdingPort(githubPort(fake.wire), () => store, guard);
    return { store, fake, merge: () => port.merge(REPO, 1, MOVED, "squash") };
  }

  const cliRelease = (actor: string) => (store: ShepherdStore, port: GitHubPort) => releaseAtHead(store, port, { runId: "run-1", repo: REPO, pr: 1, head: REVIEWED, actor });
  const reholdAt = (store: ShepherdStore) => adversaryRehold(store, "run-1", { head: MOVED, baseRef: async () => "main" }, async () => FIX_PUSH);

  it("is no adversary history: a new head is not re-held and the merge goes ahead", async () => {
    const r = await heldUnread(async (store) => store.reclassIfHeld("run-1", UNREAD, () => undefined, { actor: "shepherd", headSha: REVIEWED }));

    expect(await reholdAt(r.store)).toBeUndefined();
    await r.merge();
    expect(r.fake.pr(1).merged).toBe(true);
  });

  it("is still adversary history when a seat released it, so a new head is re-held and the merge refused", async () => {
    const r = await heldUnread(cliRelease("seat-x"));

    expect((await reholdAt(r.store))?.reason).toContain(`from ${REVIEWED} to ${MOVED}`);
    await expect(r.merge()).rejects.toBeInstanceOf(MergeHeldError);
  });

  it("is still adversary history when a CLI release names the actor shepherd, so a new head is re-held", async () => {
    const r = await heldUnread(cliRelease("shepherd"));

    expect(r.store.eventsOf("run-1").at(-1)).toMatchObject({ kind: "release", actor: "shepherd", reason: UNREAD });
    expect((await reholdAt(r.store))?.reason).toContain(`from ${REVIEWED} to ${MOVED}`);
    await expect(r.merge()).rejects.toBeInstanceOf(MergeHeldError);
  });
});
