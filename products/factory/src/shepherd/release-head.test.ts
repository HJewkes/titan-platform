import { fakeGitHub, fakeSha, githubPort, type GitHubPort } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { partialFake } from "@titan-design/test-kit";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it, vi } from "vitest";
import { adversaryRehold } from "./adversary-anchor.js";
import { shepherdEventMigration } from "./events.js";
import { ownUpdatedHeads, type MergeUpReads } from "./merge-up-release.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { releaseAtHead } from "./release-head.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";
import type { CarryInput, CarryResult } from "./tree-carry.js";

const REPO = "octo/demo";
const REVIEWED = fakeSha("reviewed");
const MERGED_UP = fakeSha("merged-up");
const MAIN = fakeSha("main-tip");
const TREE = fakeSha("merge-tree");
const ADVERSARY = "g10-adversary: trust rule (security); TP-1";
const STALL = "stalled: no progress; TP-2";

const CLEAN_MERGE_UP: CarryResult = { equal: true, base: MAIN, firstParent: REVIEWED, headTree: TREE, mergeTree: TREE };

interface Rig {
  store: ShepherdStore;
  port: GitHubPort;
  carry: ReturnType<typeof vi.fn<(input: CarryInput) => Promise<CarryResult>>>;
  reads: MergeUpReads;
  release: (holdClass?: string) => ReturnType<typeof releaseAtHead>;
}

/** A run held at REVIEWED by `reason`, whose PR is now at MERGED_UP; `ownUpdates` are the heads Shepherd's update-branch made. */
function rig(probe: CarryResult | Error, { reason = ADVERSARY, ownUpdates = [MERGED_UP] }: { reason?: string; ownUpdates?: string[] } = {}): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  fake.addPr({ headSha: MERGED_UP, baseRef: "main" });
  store.register({ repo: REPO, pr: 1, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  store.hold("run-1", reason, undefined, { actor: "shepherd", headSha: REVIEWED });
  const carry = vi.fn(async (_input: CarryInput) => (probe instanceof Error ? Promise.reject(probe) : probe));
  const reads = { ownUpdates: () => new Set(ownUpdates), carry };
  const port = githubPort(fake.wire);
  return { store, port, carry, reads, release: (holdClass) => releaseAtHead(store, port, { runId: "run-1", repo: REPO, pr: 1, head: REVIEWED, actor: "seat", ...(holdClass && { holdClass }) }, reads) };
}

const lastEvent = (store: ShepherdStore) => store.eventsOf("run-1").at(-1);

describe("a g10-adversary release at the reviewed head after Shepherd's own merge-up", () => {
  it("is accepted when the PR's head is Shepherd's clean merge of main into the reviewed head", async () => {
    const r = rig(CLEAN_MERGE_UP);

    const after = await r.release();

    expect(after.held).toBe(false);
    expect(r.carry).toHaveBeenCalledWith({ repo: REPO, baseRef: "main", fromHead: REVIEWED, head: MERGED_UP });
    expect(lastEvent(r.store)).toMatchObject({ kind: "release", actor: "seat", headSha: REVIEWED });
    expect(r.store.vouchedLine("run-1", REVIEWED, "main")).toEqual(new Set([REVIEWED, MERGED_UP]));
  });

  it("leaves the merge guard nothing to re-hold at the merged-up head, with no second probe", async () => {
    const r = rig(CLEAN_MERGE_UP);
    await r.release();
    const probeAgain = vi.fn(async (): Promise<CarryResult> => ({ equal: false }));

    const rehold = await adversaryRehold(r.store, "run-1", { head: MERGED_UP, baseRef: async () => "main" }, probeAgain);

    expect(rehold).toBeUndefined();
    expect(probeAgain).not.toHaveBeenCalled();
  });

  it("is refused when the merge is not one Shepherd's update-branch made, without probing it", async () => {
    const r = rig(CLEAN_MERGE_UP, { ownUpdates: [] });

    await expect(r.release()).rejects.toThrow(`not ${REVIEWED}`);

    expect(r.carry).not.toHaveBeenCalled();
    expect(r.store.byRun("run-1")?.held).toBe(true);
  });

  it.each<[string, CarryResult | Error]>([
    ["a conflicted merge", { equal: false, base: MAIN, reason: `${REVIEWED} conflicts with ${MAIN}` }],
    ["a merge whose tree is not the clean merge-tree", { equal: true, base: MAIN, firstParent: REVIEWED, headTree: fakeSha("hand-resolved"), mergeTree: TREE }],
    ["an extra commit on top of the merge", { equal: false, reason: `${MERGED_UP} has 1 parents, not the two of a merge update` }],
    ["a merge into some other head", { ...CLEAN_MERGE_UP, firstParent: fakeSha("other-head") }],
    ["a probe that fails", new Error("git fetch failed")],
  ])("is refused for %s, and keeps the hold with no release or proof recorded", async (_case, probe) => {
    const r = rig(probe);

    await expect(r.release()).rejects.toMatchObject({ code: 65 });

    expect(r.store.byRun("run-1")?.held).toBe(true);
    expect(lastEvent(r.store)?.kind).toBe("hold");
    expect(r.store.vouchedLine("run-1", REVIEWED, "main")).toEqual(new Set([REVIEWED]));
  });

  it("is refused for a hold of another class, even across a clean merge-up", async () => {
    const r = rig(CLEAN_MERGE_UP, { reason: STALL });

    await expect(r.release()).rejects.toThrow(`not ${REVIEWED}`);

    expect(r.carry).not.toHaveBeenCalled();
    expect(r.store.byRun("run-1")?.held).toBe(true);
  });

  it("is accepted when the release names the g10-adversary class", async () => {
    const r = rig(CLEAN_MERGE_UP);

    const after = await r.release("g10-adversary");

    expect(after.held).toBe(false);
  });
});

describe("the heads Shepherd's own update-branch made", () => {
  const stepOf = (stepId: string, result: object): StepResult => partialFake<StepResult>({ stepId, data: { result } });

  it("are the update-branch results that read as its own merge, from the land loop and a freeze-hold refresh alike", () => {
    const run = partialFake<WorkflowRun>({
      stepResults: {
        a: stepOf("update-branch:0:0", { headSha: MERGED_UP, own: true }),
        b: stepOf("update-branch:sh-freeze-hold:0", { headSha: fakeSha("thawed"), own: true }),
        c: stepOf("update-branch:1:0", { headSha: fakeSha("seat-push"), own: false }),
        d: stepOf("ci-wait:0", { headSha: fakeSha("ci-read"), own: true }),
      },
    });

    expect(ownUpdatedHeads(run)).toEqual(new Set([MERGED_UP, fakeSha("thawed")]));
  });
});
