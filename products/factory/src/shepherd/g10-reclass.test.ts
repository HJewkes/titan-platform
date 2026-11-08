import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubPort, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { reclassMarkMigration, shepherdEventMigration } from "./events.js";
import { reclassUnread } from "./g10-reclass.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { applyRegistrationHold } from "./registration-hold.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";

const REPO = "octo/demo";
const HEAD = fakeSha("head-2");
const UNREAD = "g10-adversary: changed files unread at registration (Error)";

const file = (path: string, additions: number, deletions = 0): PrFile => ({ path, status: "modified", additions, deletions });

interface Rig {
  fake: FakeGitHub;
  port: GitHubPort;
  store: ShepherdStore;
  /** The file reads still to fail; each failed read spends one. */
  failing: { reads: number };
  reads: () => number;
}

function rig(files: PrFile[]): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), reclassMarkMigration(25)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: fakeSha("head-1") });
  fake.prFiles.set(pr, files);
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "correctness" });
  const real = githubPort(fake.wire);
  const failing = { reads: 0 };
  let reads = 0;
  const listPrFiles: GitHubPort["listPrFiles"] = (repo, n) => {
    reads++;
    if (failing.reads > 0) return (failing.reads--, Promise.reject(new Error("rate limited")));
    return real.listPrFiles(repo, n);
  };
  return { fake, port: { ...real, listPrFiles }, store, failing, reads: () => reads };
}

/** Registration's read and its one retry both fail, so the run is held unread. */
async function heldUnread(r: Rig): Promise<void> {
  r.failing.reads = 2;
  expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe(UNREAD);
}

const reclass = (r: Rig) =>
  reclassUnread({ port: r.port, store: { get: () => r.store, bind: () => () => undefined }, now: () => 0, sleep: async () => undefined }, { runId: "run-1", head: HEAD }, new AbortController().signal);

describe("a run held because its changed files were unread at registration, read again at a CI read", () => {
  it("is unheld when the whole read finds a 900-line PR with no adversary touch, as its registration would have left it", async () => {
    const r = rig([file("packages/x/src/a.ts", 600, 150), file("packages/x/src/a.test.ts", 150)]);
    await heldUnread(r);

    expect(await reclass(r)).toEqual({ reclassed: true });

    expect(r.store.byRun("run-1")?.held).toBe(false);
    expect(r.store.eventsOf("run-1").map(({ kind, reason, actor, headSha, reclass }) => ({ kind, reason, actor, headSha, reclass }))).toEqual([
      { kind: "hold", reason: UNREAD, actor: "shepherd", headSha: null, reclass: undefined },
      { kind: "release", reason: UNREAD, actor: "shepherd", headSha: HEAD, reclass: true },
    ]);
  });

  it("keeps its hold when the whole read finds an authority touch", async () => {
    const r = rig([file("packages/authority/src/x.ts", 20)]);
    await heldUnread(r);

    expect(await reclass(r)).toEqual({ reclassed: false, kept: "g10-adversary: authority touch" });

    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: UNREAD });
    expect(r.store.eventsOf("run-1")).toHaveLength(1);
  });

  it("keeps its hold when the read fails again on both tries", async () => {
    const r = rig([file("packages/x/src/a.ts", 10)]);
    await heldUnread(r);
    r.failing.reads = 2;

    expect(await reclass(r)).toEqual({ reclassed: false, kept: UNREAD });

    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: UNREAD });
  });

  it("keeps its hold when the list comes back cut short at GitHub's cap", async () => {
    const r = rig([file("packages/x/src/a.ts", 10)]);
    await heldUnread(r);
    r.fake.prChangedFiles.set(1, 5000);

    expect(await reclass(r)).toEqual({ reclassed: false, kept: "g10-adversary: changed files unread at registration (FileListTruncatedError)" });

    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: UNREAD });
  });

  it("lifts only the unread hold, leaving the stall parked under it gating", async () => {
    const r = rig([file("packages/x/src/a.ts", 10)]);
    r.store.hold("run-1", "stalled: no progress; TP-2", undefined, { actor: "seat" });
    await heldUnread(r);

    expect(await reclass(r)).toEqual({ reclassed: true });

    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: "stalled: no progress; TP-2" });
  });

  it("reads nothing for a run held for another reason", async () => {
    const r = rig([file("packages/x/src/a.ts", 10)]);
    r.store.hold("run-1", "g10-adversary: authority touch");

    expect(await reclass(r)).toEqual({ reclassed: false });

    expect(r.reads()).toBe(0);
    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: "g10-adversary: authority touch" });
  });
});

describe("a run with no G10 hold, classed again at a CI read", () => {
  it("is held g10-adversary when a bump fixer's push adds an authority file to a manifest-only head", async () => {
    const r = rig([file("package.json", 1, 1), file("pnpm-lock.yaml", 4, 4)]);
    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBeUndefined();
    r.fake.prFiles.set(1, [file("package.json", 1, 1), file("pnpm-lock.yaml", 4, 4), file("packages/authority/src/x.ts", 20)]);

    expect(await reclass(r)).toEqual({ reclassed: false, placed: "g10-adversary: authority touch" });

    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: "g10-adversary: authority touch" });
  });

  it("stays unheld when the pushed head still has no adversary touch", async () => {
    const r = rig([file("packages/x/src/a.ts", 10)]);

    expect(await reclass(r)).toEqual({ reclassed: false });

    expect(r.store.byRun("run-1")?.held).toBe(false);
  });

  it("stacks the adversary hold over a stall, which waits under it", async () => {
    const r = rig([file("packages/authority/src/x.ts", 20)]);
    r.store.hold("run-1", "stalled: no progress; TP-2", undefined, { actor: "seat" });

    expect(await reclass(r)).toEqual({ reclassed: false, placed: "g10-adversary: authority touch" });

    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: "g10-adversary: authority touch" });
  });

  it("reads nothing once a seat released its adversary hold, leaving the re-hold to its own rule", async () => {
    const r = rig([file("packages/authority/src/x.ts", 20)]);
    r.store.hold("run-1", "g10-adversary: authority touch", undefined, { actor: "shepherd" });
    r.store.release("run-1", { actor: "seat" });

    expect(await reclass(r)).toEqual({ reclassed: false });

    expect(r.reads()).toBe(0);
    expect(r.store.byRun("run-1")?.held).toBe(false);
  });
});
