import { fakeGitHub, fakeSha, githubPort, type FakeGitHub } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { holdSlotsMigration } from "./store-migrations.js";
import { adversaryGuard } from "./adversary-guard.js";
import { shepherdEventMigration } from "./events.js";
import { MergeHeldError, holdingPort } from "./hold.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";
import type { CarryResult } from "./tree-carry.js";

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
function rig(probe: () => Promise<CarryResult>, head = MOVED): Rig {
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
