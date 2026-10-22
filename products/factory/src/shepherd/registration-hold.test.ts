import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubPort, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { reclassMarkMigration, shepherdEventMigration } from "./events.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { reclassedUnread } from "./g10-reclass-events.js";
import { applyRegistrationHold, everG10Held, g10HoldAt, isUnreadRegistrationHold, stackedOver } from "./registration-hold.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";

const REPO = "octo/demo";

const file = (path: string, additions: number, deletions = 0): PrFile => ({ path, status: "modified", additions, deletions });

interface Rig {
  fake: FakeGitHub;
  port: GitHubPort;
  store: ShepherdStore;
}

function rig(files: PrFile[], kind = "feature"): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), reclassMarkMigration(25)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: fakeSha("head-1") });
  fake.prFiles.set(pr, files);
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind });
  return { fake, port: githubPort(fake.wire), store };
}

const holdOf = (r: Rig) => g10HoldAt(r.port, { repo: REPO, pr: 1 });

/** Lands a seat's hold just before Shepherd's first compare-and-swap, so that one loses. */
function loseFirstSwap(store: ShepherdStore, competing: string): void {
  const holdIfUnchanged = store.holdIfUnchanged.bind(store);
  let lost = false;
  store.holdIfUnchanged = (runId, mark, reason, by) => {
    if (!lost) {
      lost = true;
      store.hold(runId, competing);
    }
    return holdIfUnchanged(runId, mark, reason, by);
  };
}

describe("the G10 hold Shepherd places at registration", () => {
  it("holds an adversarial-path PR g10-adversary and records the hold as Shepherd's", async () => {
    const r = rig([file("packages/tool-guard/src/a.ts", 30)]);

    const reason = await applyRegistrationHold(r.port, r.store, "run-1");

    expect(reason).toBe("g10-adversary: security touch");
    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: reason });
    expect(r.store.eventsOf("run-1")).toEqual([expect.objectContaining({ kind: "hold", reason, actor: "shepherd" })]);
  });

  it("leaves a 900-line correctness PR unheld, since one Opus reviewer covers its size", async () => {
    const r = rig([file("packages/x/src/a.ts", 600, 150), file("packages/x/src/a.test.ts", 150)], "correctness");

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBeUndefined();
    expect(r.store.byRun("run-1")?.held).toBe(false);
    expect(r.store.eventsOf("run-1")).toEqual([]);
  });

  it("holds an authority touch g10-adversary, and an authority touch over 400 lines too", async () => {
    const small = rig([file("packages/authority/src/x.ts", 20)]);
    const large = rig([file("packages/authority/src/x.ts", 20), file("packages/x/src/a.ts", 500)]);

    expect(await holdOf(small)).toBe("g10-adversary: authority touch");
    expect(await holdOf(large)).toBe("g10-adversary: authority touch");
  });

  it.each([10, 500])("leaves a %i-line security kind with no sensitive path unheld", async (lines) => {
    const r = rig([file("packages/x/src/a.ts", lines)], "security");

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBeUndefined();
    expect(r.store.byRun("run-1")?.held).toBe(false);
  });

  it("keeps a security kind on a tool-guard path g10-adversary", async () => {
    const r = rig([file("packages/tool-guard/src/a.ts", 10)], "security");

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe("g10-adversary: security touch");
  });

  it("names only the path touch of a security kind on a policy path", async () => {
    const r = rig([file("products/factory/src/shepherd/g10-release.ts", 10)], "security");

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe("g10-adversary: policy touch");
  });

  it("leaves a test-only change to a Shepherd policy file unheld", async () => {
    const r = rig([file("products/factory/src/shepherd/g10-release.test.ts", 10)]);

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBeUndefined();
  });

  it.each(["src/leak-guard/scan.ts", "src/leak-guard/deep/x.ts", "src/agents/worker-self-grant.ts", "src/cli/verbs/permission-hook.ts", "src/broker/host-directory.ts"])(
    "holds an agent-chat security path %s g10-adversary",
    async (path) => {
      const r = rig([file(path, 10)]);

      expect(await holdOf(r)).toBe("g10-adversary: security touch");
    },
  );

  it.each(["src/leak-guard/scan.test.ts", "src/broker/host-directory.test.ts", "apps/console/server/owner-tap.test.ts", "products/factory/src/shepherd/owner-release.test.ts"])("leaves a test file %s of an agent-chat security path unheld", async (path) => {
    const r = rig([file(path, 10)]);

    expect(await holdOf(r)).toBeUndefined();
  });

  it.each(["store-migrations.ts", "store.ts", "events.ts", "train.ts", "account-store.ts"])("leaves a factory store migration in %s unheld", async (name) => {
    const r = rig([file(`products/factory/src/shepherd/${name}`, 30)]);

    expect(await holdOf(r)).toBeUndefined();
  });

  it.each([
    ["apps/console/server/owner-tap.ts", "policy"],
    ["apps/console/server/inbox-actions.ts", "policy"],
    ["products/factory/src/gate-resolve.ts", "policy"],
    ["products/factory/src/gate-resolve-evidence.ts", "policy"],
    ["products/factory/src/cli-owner-release.ts", "policy"],
    ["products/factory/src/shepherd/owner-release.ts", "policy"],
    [".github/workflows/fix-proof.yml", "authority"],
    ["profiles/bd-reviewer.json", "security"],
    ["src/agents/profiles.ts", "security"],
    ["src/agents/profile-baseline.ts", "security"],
    ["apps/console/server/owner-tap-kernel.ts", "policy"],
    ["apps/console/server/inbox-actions-render.ts", "policy"],
    ["products/factory/src/shepherd/owner-release-proof.ts", "policy"],
    ["products/factory/src/owner-release-cli.ts", "policy"],
  ])("holds an owner-action or agent profile path %s g10-adversary", async (path, touch) => {
    const r = rig([file(path, 10)]);

    expect(await holdOf(r)).toBe(`g10-adversary: ${touch} touch`);
  });

  it.each(["g10-release.ts", "g10-rehold.ts", "adversary-guard.ts", "adversary-anchor.ts", "merge-evidence-gate.ts", "task-kind.ts", "registration-hold.ts", "release-head.ts", "commands.ts", "operator-hold.ts", "seats.ts", "release.ts", "reviewer-choice.ts"])(
    "holds Shepherd's merge policy in %s g10-adversary",
    async (name) => {
      const r = rig([file(`products/factory/src/shepherd/${name}`, 10)]);

      expect(await holdOf(r)).toBe("g10-adversary: policy touch");
    },
  );

  it("leaves a small plain-source PR of an unknown kind unheld", async () => {
    const r = rig([file("packages/x/src/a.ts", 50)], "unknown");

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBeUndefined();
  });

  it("leaves a PR unheld when a file carries no line counts", async () => {
    const r = rig([{ path: "packages/x/src/a.ts", status: "modified" }]);

    expect(await holdOf(r)).toBeUndefined();
  });

  it("fails closed to g10-adversary when the file list is cut short or cannot be read", async () => {
    const truncated = rig([file("packages/x/src/a.ts", 5)]);
    truncated.fake.prChangedFiles.set(1, 5000);
    const unreadable = rig([file("packages/x/src/a.ts", 5)]);
    unreadable.port = { ...unreadable.port, listPrFiles: () => Promise.reject(new Error("server error")) };

    expect(await applyRegistrationHold(truncated.port, truncated.store, "run-1")).toBe("g10-adversary: changed files unread at registration (FileListTruncatedError)");
    expect(await applyRegistrationHold(unreadable.port, unreadable.store, "run-1")).toBe("g10-adversary: changed files unread at registration (Error)");
    expect(unreadable.store.byRun("run-1")?.held).toBe(true);
  });

  it("classes the PR normally when the file read fails once and then succeeds", async () => {
    const r = rig([file("packages/authority/src/x.ts", 10)]);
    const listPrFiles = r.port.listPrFiles;
    let reads = 0;
    r.port = { ...r.port, listPrFiles: (repo, pr) => (++reads === 1 ? Promise.reject(new Error("server error")) : listPrFiles(repo, pr)) };

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe("g10-adversary: authority touch");
    expect(reads).toBe(2);
  });

  it("still fails closed when the file read fails twice, reading no third time", async () => {
    const r = rig([file("packages/x/src/a.ts", 5)]);
    let reads = 0;
    r.port = { ...r.port, listPrFiles: () => (reads++, Promise.reject(new Error("server error"))) };

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe("g10-adversary: changed files unread at registration (Error)");
    expect(reads).toBe(2);
  });

  it("does not re-read a file list cut short at GitHub's cap", async () => {
    const r = rig([file("packages/x/src/a.ts", 5)]);
    r.fake.prChangedFiles.set(1, 5000);
    const listPrFiles = r.port.listPrFiles;
    let reads = 0;
    r.port = { ...r.port, listPrFiles: (repo, pr) => (reads++, listPrFiles(repo, pr)) };

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe("g10-adversary: changed files unread at registration (FileListTruncatedError)");
    expect(reads).toBe(1);
  });

  it("stacks a g10-adversary hold over a hold the run already has, which gates again once it is released", async () => {
    const r = rig([file("packages/authority/src/x.ts", 10)]);
    r.store.hold("run-1", "stalled: seat away; TP-1");

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe("g10-adversary: authority touch");
    expect(r.store.release("run-1")).toMatchObject({ held: true, holdReason: "stalled: seat away; TP-1" });
  });

  it("stacks a g10-adversary hold over another class, so neither hold is lost", async () => {
    const r = rig([file("packages/authority/src/x.ts", 10)]);
    r.store.hold("run-1", "visual-gate2: screenshots pending");

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe("g10-adversary: authority touch");
    expect(r.store.release("run-1").holdReason).toBe("visual-gate2: screenshots pending");
  });

  it("retries a lost compare-and-swap and stacks the G10 hold on the hold that won it", async () => {
    const r = rig([file("packages/authority/src/x.ts", 10)]);
    loseFirstSwap(r.store, "stalled: seat away; TP-1");

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe("g10-adversary: authority touch");
    expect(r.store.eventsOf("run-1").map((event) => event.reason)).toEqual(["stalled: seat away; TP-1", "g10-adversary: authority touch"]);
  });

  it("places nothing when the hold that won the compare-and-swap is a G10 hold", async () => {
    const r = rig([file("packages/authority/src/x.ts", 10)]);
    loseFirstSwap(r.store, "g10-adversary: seat's own hold");

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBeUndefined();
    expect(r.store.byRun("run-1")?.holdReason).toBe("g10-adversary: seat's own hold");
  });

  it("leaves a G10 hold the run inherited as strong as the one it needs", () => {
    expect(stackedOver("g10-adversary: authority touch", "g10-review: 900 changed lines")).toBeUndefined();
    expect(stackedOver("g10-review: 500 changed lines", "g10-review: 900 changed lines")).toBeUndefined();
    expect(stackedOver("g10-review: 500 changed lines", "g10-adversary: policy touch")).toBe("g10-adversary: policy touch");
  });

  it("does not re-hold a run whose G10 hold was already placed and released", async () => {
    const r = rig([file("packages/authority/src/x.ts", 10)]);
    r.store.hold("run-1", "g10-adversary: authority touch");
    r.store.releaseIfHeld("run-1", "g10-adversary: authority touch");

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBeUndefined();
    expect(r.store.byRun("run-1")?.held).toBe(false);
  });

  const renamed = (previousPath: string, path: string): PrFile => ({ path, previousPath, status: "renamed", additions: 12, deletions: 8 });

  it.each([
    ["products/factory/src/shepherd/commands.ts", "products/factory/src/shepherd/cmds.ts", "policy"],
    ["products/factory/src/shepherd/g10-release.ts", "products/factory/src/shepherd/release-gate.ts", "policy"],
    ["packages/authority/src/x.ts", "packages/other/src/x.ts", "authority"],
  ])("holds a 20-line rename of %s to %s g10-adversary by its old path", async (from, to, touch) => {
    const r = rig([renamed(from, to)]);

    expect(await holdOf(r)).toBe(`g10-adversary: ${touch} touch`);
  });

  it("holds a delete of a policy file g10-adversary", async () => {
    const r = rig([{ path: "products/factory/src/shepherd/g10-release.ts", status: "removed", additions: 0, deletions: 40 }]);

    expect(await holdOf(r)).toBe("g10-adversary: policy touch");
  });

  it("holds g10-adversary when the run's hold history cannot be read", async () => {
    const r = rig([file("packages/x/src/a.ts", 10)]);
    r.store.eventsOf = () => {
      throw new Error("disk I/O error");
    };

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe("g10-adversary: hold history unread at registration (Error)");
    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: "g10-adversary: hold history unread at registration (Error)" });
  });

  it("keeps a seat's g10-adversary hold and its reviewer when the hold history cannot be read", async () => {
    const r = rig([file("packages/x/src/a.ts", 10)]);
    r.store.hold("run-1", "g10-adversary: merge-policy change", "sec-audit-review");
    r.store.eventsOf = () => {
      throw new Error("disk I/O error");
    };

    const reason = await applyRegistrationHold(r.port, r.store, "run-1");

    expect(reason).toBeUndefined();
    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: "g10-adversary: merge-policy change", holdReviewer: "sec-audit-review" });
  });

  it("holds g10-adversary over a non-adversary hold when the history cannot be read, and the other hold waits under it", async () => {
    const r = rig([file("packages/x/src/a.ts", 10)]);
    r.store.hold("run-1", "stalled: x; TP-1");
    r.store.eventsOf = () => {
      throw new Error("disk I/O error");
    };

    const reason = await applyRegistrationHold(r.port, r.store, "run-1");
    const gating = r.store.byRun("run-1")?.holdReason;
    r.store.releaseClass("run-1", "g10-adversary");

    expect(reason).toBe("g10-adversary: hold history unread at registration (Error)");
    expect(gating).toBe(reason);
    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: "stalled: x; TP-1" });
  });

  it("leaves a commands.ts outside Shepherd unheld", async () => {
    const r = rig([file("packages/cli/src/commands.ts", 10)]);

    expect(await holdOf(r)).toBeUndefined();
  });

  it("escalates to g10-adversary when a seat's g10-review hold lands during the file read", async () => {
    const r = rig([file("packages/authority/src/x.ts", 10)]);
    const listPrFiles = r.port.listPrFiles;
    r.port = { ...r.port, listPrFiles: async (repo, pr) => (r.store.hold("run-1", "g10-review: seat's own hold"), listPrFiles(repo, pr)) };

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe("g10-adversary: authority touch");
    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: "g10-adversary: authority touch" });
  });

  it("escalates to g10-adversary over a released g10-review hold the run inherited", async () => {
    const r = rig([file("packages/authority/src/x.ts", 10)]);
    r.store.hold("run-1", "g10-review: 900 changed lines");
    r.store.releaseIfHeld("run-1", "g10-review: 900 changed lines");

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe("g10-adversary: authority touch");
  });

  it("does not re-hold a run whose g10-adversary hold was released, whatever class it now needs", async () => {
    const r = rig([file("packages/x/src/a.ts", 900)]);
    r.store.hold("run-1", "g10-adversary: authority touch");
    r.store.releaseIfHeld("run-1", "g10-adversary: authority touch");
    let reads = 0;
    const listPrFiles = r.port.listPrFiles;
    r.port = { ...r.port, listPrFiles: async (repo, pr) => (reads++, listPrFiles(repo, pr)) };

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("keeps a hold placed while the file list was read, under the G10 hold", async () => {
    const r = rig([file("packages/authority/src/x.ts", 10)]);
    const listPrFiles = r.port.listPrFiles;
    r.port = { ...r.port, listPrFiles: async (repo, pr) => (r.store.hold("run-1", "stalled: seat away; TP-1"), listPrFiles(repo, pr)) };

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe("g10-adversary: authority touch");
    expect(r.store.release("run-1").holdReason).toBe("stalled: seat away; TP-1");
  });
});

describe("an unread-files hold re-classed by Shepherd", () => {
  const UNREAD = "g10-adversary: changed files unread at registration (GhError)";

  it("recognises the unread-files reason for any error name, and no other adversary reason", () => {
    expect(isUnreadRegistrationHold(UNREAD)).toBe(true);
    expect(isUnreadRegistrationHold("g10-adversary: changed files unread at registration (FileListTruncatedError)")).toBe(true);
    expect(isUnreadRegistrationHold("g10-adversary: hold history unread at registration (Error)")).toBe(false);
    expect(isUnreadRegistrationHold("g10-adversary: authority change; TP-1")).toBe(false);
  });

  it.each(["seat-x", "shepherd"])("re-classes nothing for a release by %s that is not Shepherd's re-class", async (actor) => {
    const r = rig([file("products/factory/src/shepherd/g10-x.ts", 10)]);
    r.store.hold("run-1", UNREAD);
    r.store.releaseIfHeld("run-1", UNREAD, { actor });

    expect(reclassedUnread(r.store.eventsOf("run-1")).size).toBe(0);
    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBeUndefined();
  });

  it("a repeat registration escalates a re-classed run whose diff now touches policy", async () => {
    const r = rig([file("products/factory/src/shepherd/g10-x.ts", 10)]);
    r.store.hold("run-1", UNREAD);
    r.store.reclassIfHeld("run-1", UNREAD, () => undefined, { actor: "shepherd" });

    expect(reclassedUnread(r.store.eventsOf("run-1")).size).toBe(2);
    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe("g10-adversary: policy touch");
  });

  it("still counts a re-classed unread hold when picking the run's reviewer", () => {
    const r = rig([file("packages/x/src/a.ts", 10)]);
    r.store.hold("run-1", UNREAD);
    r.store.reclassIfHeld("run-1", UNREAD, () => undefined, { actor: "shepherd" });

    expect(everG10Held(r.store, "run-1")).toBe(true);
  });
});
