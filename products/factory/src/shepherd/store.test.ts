import { appliedVersions, openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { accountLimitMigration } from "./account-store.js";
import { holdSlotsMigration, parkSettledMigration, registrationFactsMigration } from "./store-migrations.js";
import { reclassMarkMigration, shepherdEventMigration } from "./events.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { ShepherdStore, lineageMigration, shepherdMigration, shepherdStoreRef, sliceMigration, holdReviewerMigration, holdSatisfiedMigration, type AuthorInput, type RegistrationInput } from "./store.js";
import { mergeBaseExceptionMigration } from "./merge-base-exception.js";

function openStore(): ShepherdStore {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), reclassMarkMigration(25)]);
  return new ShepherdStore(db, () => Date.parse("2026-01-01T00:00:00Z"));
}

const base: RegistrationInput = { repo: "octo/demo", pr: 7, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY };

describe("shepherd registration store", () => {
  it("stores a registration without a kind as unknown", () => {
    const store = openStore();

    const registration = store.register(base);

    expect(registration).toMatchObject({ repo: "octo/demo", pr: 7, branch: null, kind: "unknown", held: false, reviewer: null, policy: OWNER_GATE_POLICY });
  });

  it("stores the slice label, and none when the registration has no slice", () => {
    const store = openStore();

    expect(store.register({ ...base, slice: "S4" }).slice).toBe("S4");
    expect(store.register({ ...base, pr: 8, runId: "run-2" }).slice).toBeNull();
  });

  it("adds the slice column to a database that already holds registrations", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4)]);
    db.prepare("INSERT INTO shepherd_registration (repo, pr, run_id, task, implementer, policy, kind, created_at, updated_at) VALUES ('octo/demo', 7, 'run-1', 'demo/1', 'impl-a', ?, 'unknown', 't', 't')").run(JSON.stringify(OWNER_GATE_POLICY));

    runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9)]);

    expect(new ShepherdStore(db).byRun("run-1")).toMatchObject({ pr: 7, slice: null });
  });

  it("adds the hold reviewer column to a database that already holds a hold", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), sliceMigration(8)]);
    new ShepherdStore(db).register(base);
    db.prepare("UPDATE shepherd_registration SET held = 1, hold_reason = 'owner review'").run();

    runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9)]);

    expect(new ShepherdStore(db).byRun("run-1")).toMatchObject({ held: true, holdReason: "owner review", holdReviewer: null });
  });

  it("refuses a kind outside the known set instead of treating it as unknown", () => {
    expect(() => openStore().register({ ...base, kind: "hotfix" })).toThrow();
  });

  it("keeps the kind and the effective policy it was given", () => {
    const policy: EffectivePolicy = { merge: "never", mergeMethod: "rebase", reviewer: "rev-a", fixer: true, seat: "demo-seat" };

    const registration = openStore().register({ ...base, kind: "correctness", policy });

    expect(registration).toMatchObject({ kind: "correctness", policy });
  });

  it("allows one registration per PR and one per branch in a repo", () => {
    const store = openStore();
    store.register(base);
    store.register({ ...base, pr: undefined, branch: "feat/a", runId: "run-2" });

    expect(() => store.register({ ...base, runId: "run-3" })).toThrow(/UNIQUE/);
    expect(() => store.register({ ...base, pr: undefined, branch: "feat/a", runId: "run-4" })).toThrow(/UNIQUE/);
    expect(() => store.register({ ...base, repo: "octo/other", runId: "run-5" })).not.toThrow();
  });

  it("a repeat registration with a looser policy keeps the stricter stored one", () => {
    const store = openStore();
    const stored: EffectivePolicy = { merge: "owner-gate", mergeMethod: "squash", fixer: false, seat: "demo-seat" };
    store.register({ ...base, policy: stored });

    const updated = store.update("run-1", { ...base, policy: { ...stored, merge: "auto", fixer: true } });

    expect(updated.policy).toEqual(stored);
  });

  it("a repeat registration cannot change the stored owner-gate reason", () => {
    const store = openStore();
    const stored: EffectivePolicy = { merge: "owner-gate", ownerGateReason: "gate-2-visual", mergeMethod: "squash", fixer: false, seat: "demo-seat" };
    store.register({ ...base, policy: stored });

    const updated = store.update("run-1", { ...base, policy: { ...stored, ownerGateReason: "proof-fixture" } });

    expect(updated.policy.ownerGateReason).toBe("gate-2-visual");
  });

  it("a repeat registration with a stricter policy narrows the stored one", () => {
    const store = openStore();
    store.register({ ...base, policy: { merge: "auto", mergeMethod: "squash", fixer: true, seat: "demo-seat" } });

    const updated = store.update("run-1", { ...base, policy: { merge: "never", mergeMethod: "rebase", fixer: false, seat: "demo-seat" } });

    expect(updated.policy).toEqual({ merge: "never", mergeMethod: "rebase", fixer: false, seat: "demo-seat" });
  });

  it("a repeat registration without a kind keeps the stored kind", () => {
    const store = openStore();
    store.register({ ...base, kind: "correctness" });

    store.update("run-1", { ...base, kind: undefined });

    expect(store.byRun("run-1")?.kind).toBe("correctness");
  });

  it.each([
    ["correctness", "unknown"],
    ["security", "feature"],
    ["correctness", "refactor"],
    ["security", "correctness"],
    ["security", "refactor"],
    ["security", "unknown"],
  ] as const)("refuses a repeat that moves %s to %s, naming both kinds", (from, to) => {
    const store = openStore();
    store.register({ ...base, kind: from });

    expect(() => store.update("run-1", { ...base, kind: to })).toThrow(new RegExp(`${from}.*${to}`));
    expect(store.byRun("run-1")?.kind).toBe(from);
  });

  it.each([
    ["correctness", "correctness"],
    ["correctness", "security"],
    ["security", "security"],
    ["unknown", "correctness"],
    ["feature", "security"],
    ["feature", "unknown"],
  ] as const)("a repeat moving %s to %s applies", (from, to) => {
    const store = openStore();
    store.register({ ...base, kind: from });

    store.update("run-1", { ...base, kind: to });

    expect(store.byRun("run-1")?.kind).toBe(to);
  });

  it("refuses an update to a run with no registration", () => {
    expect(() => openStore().update("run-9", base)).toThrow(/has no registration/);
  });

  it("refuses a registration with neither a PR nor a branch", () => {
    expect(() => openStore().register({ ...base, pr: undefined })).toThrow(/pr or a branch/);
  });

  it("records the PR a branch registration was waiting for, and refuses an unregistered run", () => {
    const store = openStore();
    store.register({ ...base, pr: undefined, branch: "feat/a" });

    store.setPr("run-1", 12);

    expect(store.byPr("octo/demo", 12)?.branch).toBe("feat/a");
    expect(() => store.setPr("run-9", 13)).toThrow(/no registration/);
  });

  it("reports a hold on any spelling of the repo until it is released", () => {
    const store = openStore();
    store.register(base);

    store.hold("run-1", "owner review");
    const held = store.heldReason("Octo/Demo", 7);
    store.release("run-1");

    expect(held).toBe("owner review");
    expect(store.heldReason("octo/demo", 7)).toBeUndefined();
    expect(store.heldReason("octo/demo", 8)).toBeUndefined();
  });

  it("keeps a hold's reviewer only as given, and release clears it", () => {
    const store = openStore();
    store.register(base);

    const named = store.hold("run-1", "awaiting sec-audit-review", "sec-audit-review");
    const released = store.release("run-1");
    const unnamed = store.hold("run-1", "awaiting sec-audit-review");

    expect([named.holdReviewer, released.holdReviewer, unnamed.holdReviewer]).toEqual(["sec-audit-review", null, null]);
  });

  it("records a release's own reason on its event, and the lifted hold's reason when none is given", () => {
    const store = openStore();
    store.register(base);

    store.hold("run-1", "owner review");
    const released = store.release("run-1", { actor: "shepherd:cleanup" }, "merged on rv-sec's MERGE");
    store.hold("run-1", "second look");
    store.release("run-1");

    const releases = store.eventsOf("run-1").filter((event) => event.kind === "release");
    expect(releases.map((event) => [event.reason, event.actor])).toEqual([["merged on rv-sec's MERGE", "shepherd:cleanup"], ["second look", "shepherd"]]);
    expect(released.holdReason).toBeNull();
  });

  it("holds any PR whose head branch has a held registration still waiting for its PR", () => {
    const store = openStore();
    store.register({ ...base, pr: undefined, branch: "feat/a" });

    store.hold("run-1", "owner review");

    expect(store.heldReason("octo/demo", 12, "feat/a")).toBe("owner review");
    expect(store.heldReason("octo/demo", 12, "feat/b")).toBeUndefined();
    expect(store.heldReason("octo/demo", 12)).toBeUndefined();
  });

  it("holds a PR whose bare head branch matches a hold registered as refs/heads/<branch>", () => {
    const store = openStore();
    store.register({ ...base, pr: undefined, branch: "refs/heads/feat/x" });
    store.hold("run-1", "owner review");

    expect(store.heldReason("octo/demo", 12, "feat/x")).toBe("owner review");
  });

  it("holds a PR whose head branch is given as refs/heads/<branch> against a hold registered with the bare name", () => {
    const store = openStore();
    store.register({ ...base, pr: undefined, branch: "feat/x" });
    store.hold("run-1", "owner review");

    expect(store.heldReason("octo/demo", 12, "refs/heads/feat/x")).toBe("owner review");
  });

  it("does not match a branch that only shares a prefix or suffix with the held one", () => {
    const store = openStore();
    store.register({ ...base, pr: undefined, branch: "refs/heads/feat/x" });
    store.hold("run-1", "owner review");

    expect(store.heldReason("octo/demo", 12, "feat/xy")).toBeUndefined();
    expect(store.heldReason("octo/demo", 12, "other/feat/x")).toBeUndefined();
    expect(store.heldReason("octo/demo", 12, "refs/heads/other/feat/x")).toBeUndefined();
  });
});

describe("the head and base a registration names", () => {
  const HEAD_1 = "1".repeat(40);
  const HEAD_2 = "2".repeat(40);

  function factsStore(): ShepherdStore {
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), registrationFactsMigration(24)]);
    return new ShepherdStore(db);
  }

  it("adds both columns to a database that already holds registrations, which read as null", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), sliceMigration(8)]);
    new ShepherdStore(db).register(base);

    runMigrations(db, [shepherdMigration(4), sliceMigration(8), registrationFactsMigration(24)]);

    expect(appliedVersions(db)).toContain(24);
    expect(new ShepherdStore(db).byRun("run-1")).toMatchObject({ pr: 7, headSha: null, base: null });
  });

  it("stores the head and base at registration, a new head on a repeat, and keeps what a repeat omits", () => {
    const store = factsStore();

    expect(store.register({ ...base, headSha: HEAD_1, base: "main" })).toMatchObject({ headSha: HEAD_1, base: "main" });
    expect(store.update("run-1", { ...base, headSha: HEAD_2 })).toMatchObject({ headSha: HEAD_2, base: "main" });
    expect(store.update("run-1", base)).toMatchObject({ headSha: HEAD_2, base: "main" });
  });

  it("registers without facts on a database the migration has not reached", () => {
    expect(openStore().register(base)).toMatchObject({ headSha: null, base: null });
  });
});

describe("a hold of another class beside a g10-adversary hold", () => {
  const ADVERSARY = "g10-adversary: trust rule (security)";
  const STALL = "stalled: no progress; TP-2";
  const HEAD = "1".repeat(40);

  function heldBoth(first: string, second: string): ShepherdStore {
    const store = openStore();
    store.register(base);
    store.hold("run-1", first, first === STALL ? "owner-rv" : undefined, { actor: "owner" });
    store.hold("run-1", second, second === STALL ? "owner-rv" : undefined, { actor: "seat" });
    return store;
  }

  it("still holds, under the other class and its reviewer, once the seat releases the adversary hold placed first", () => {
    const store = heldBoth(ADVERSARY, STALL);

    const gating = store.heldReason("octo/demo", 7);
    store.release("run-1", { actor: "seat", headSha: HEAD });

    expect(gating).toBe(ADVERSARY);
    expect(store.byRun("run-1")).toMatchObject({ held: true, holdReason: STALL, holdReviewer: "owner-rv" });
    expect(store.eventsOf("run-1").map((event) => event.kind)).toEqual(["hold", "hold", "release"]);
  });

  it("still holds under the other class once the seat releases an adversary hold placed over it", () => {
    const store = heldBoth(STALL, ADVERSARY);

    store.release("run-1", { actor: "seat", headSha: HEAD });

    expect(store.heldReason("octo/demo", 7)).toBe(STALL);
    expect(store.byRun("run-1")?.holdReviewer).toBe("owner-rv");
  });

  it("lifts one class per release, so the second release frees the run", () => {
    const store = heldBoth(ADVERSARY, STALL);

    store.release("run-1");
    store.release("run-1");

    expect(store.heldReason("octo/demo", 7)).toBeUndefined();
  });

  it("lifts nothing on a compare-and-swap release naming the parked class", () => {
    const store = heldBoth(ADVERSARY, STALL);

    expect(store.releaseIfHeld("run-1", STALL)).toBe(false);
    expect(store.heldReason("octo/demo", 7)).toBe(ADVERSARY);
  });

  it("writes nothing and records no event on a hold-unless-adversary over a seat's adversary hold", () => {
    const store = openStore();
    store.register(base);
    store.hold("run-1", ADVERSARY, "sec-audit-review", { actor: "seat" });
    const mark = store.changeMark("run-1");

    const placed = store.holdUnlessAdversary("run-1", "g10-adversary: fail closed");

    expect(placed).toBe(false);
    expect(store.changeMark("run-1")).toBe(mark);
    expect(store.byRun("run-1")).toMatchObject({ held: true, holdReason: ADVERSARY, holdReviewer: "sec-audit-review" });
  });

  it("places a hold-unless-adversary on an unheld run", () => {
    const store = openStore();
    store.register(base);

    const placed = store.holdUnlessAdversary("run-1", ADVERSARY);

    expect(placed).toBe(true);
    expect(store.byRun("run-1")).toMatchObject({ held: true, holdReason: ADVERSARY, holdReviewer: null });
    expect(store.eventsOf("run-1").map((event) => event.kind)).toEqual(["hold"]);
  });
});

describe("re-classing an unread-files hold in one swap", () => {
  const UNREAD = "g10-adversary: changed files unread at registration (GhError)";
  const STALL = "stalled: no progress; TP-1";
  const REVIEW = "g10-review: 900 changed lines";

  function heldUnread(over?: string): ShepherdStore {
    const store = openStore();
    store.register(base);
    if (over !== undefined) store.hold("run-1", over, undefined, { actor: "seat" });
    store.hold("run-1", UNREAD, undefined, { actor: "shepherd" });
    return store;
  }

  it("lifts the unread hold and leaves a parked stall gating, recording one release of the unread reason", () => {
    const store = heldUnread(STALL);
    const seen: (string | null)[] = [];

    const placed = store.reclassIfHeld("run-1", UNREAD, (gating) => (seen.push(gating), undefined), { actor: "shepherd" });

    expect(placed).toBeNull();
    expect(seen).toEqual([STALL]);
    expect(store.byRun("run-1")).toMatchObject({ held: true, holdReason: STALL });
    const releases = store.eventsOf("run-1").filter((event) => event.kind === "release");
    expect(releases).toMatchObject([{ reason: UNREAD, actor: "shepherd", reclass: true }]);
  });

  it("places the real class over no parked hold", () => {
    const store = heldUnread();

    const placed = store.reclassIfHeld("run-1", UNREAD, (gating) => (gating === null ? REVIEW : undefined), { actor: "shepherd" });

    expect(placed).toBe(REVIEW);
    expect(store.byRun("run-1")).toMatchObject({ held: true, holdReason: REVIEW });
    expect(store.eventsOf("run-1").map((event) => [event.kind, event.reason])).toEqual([["hold", UNREAD], ["release", UNREAD], ["hold", REVIEW]]);
  });

  it("places the real class over a parked stall without dropping it", () => {
    const store = heldUnread(STALL);
    const over = "g10-adversary: 900 changed lines, over a stalled hold";

    store.reclassIfHeld("run-1", UNREAD, (gating) => (gating === STALL ? over : undefined), { actor: "shepherd" });

    expect(store.byRun("run-1")?.holdReason).toBe(over);
    expect(store.release("run-1", { actor: "seat" }).holdReason).toBe(STALL);
  });

  it("marks no other release as the re-class, whatever actor it names", () => {
    const store = heldUnread();

    store.releaseIfHeld("run-1", UNREAD, { actor: "shepherd" });

    expect(store.eventsOf("run-1").at(-1)).not.toHaveProperty("reclass");
  });

  it("refuses to place an owner-asked hold, writing nothing", () => {
    const store = heldUnread();
    const mark = store.changeMark("run-1");

    expect(() => store.reclassIfHeld("run-1", UNREAD, () => "owner-asked: discuss", { actor: "shepherd" })).toThrow(/owner-asked/);
    expect(store.changeMark("run-1")).toBe(mark);
    expect(store.byRun("run-1")).toMatchObject({ held: true, holdReason: UNREAD, ownerHold: null });
  });

  it("refuses to re-class any hold but an unread-files one", () => {
    const store = heldUnread();
    store.hold("run-1", "g10-adversary: authority change; TP-1", undefined, { actor: "seat" });

    expect(() => store.reclassIfHeld("run-1", "g10-adversary: authority change; TP-1", () => undefined, { actor: "shepherd" })).toThrow(/unread-files/);
    expect(store.byRun("run-1")?.holdReason).toBe("g10-adversary: authority change; TP-1");
  });

  it("writes nothing when the gating hold is not the one named", () => {
    const store = heldUnread();
    store.release("run-1", { actor: "seat" });
    store.hold("run-1", "g10-adversary: authority change; TP-1", undefined, { actor: "seat" });
    const mark = store.changeMark("run-1");

    const placed = store.reclassIfHeld("run-1", UNREAD, () => REVIEW, { actor: "shepherd" });

    expect(placed).toBe(false);
    expect(store.changeMark("run-1")).toBe(mark);
    expect(store.byRun("run-1")?.holdReason).toBe("g10-adversary: authority change; TP-1");
  });
});

describe("a hold satisfied by its reviewer's MERGE", () => {
  const H1 = "1".repeat(40);
  const H2 = "2".repeat(40);
  const by = { agentId: "agent-rv", sessionId: "session-rv", locator: { sourceId: "synthetic" } };

  function heldFor(reviewer: string): ShepherdStore {
    const store = openStore();
    store.register(base);
    store.hold("run-1", "awaiting a named review", reviewer);
    return store;
  }

  it("passes a merge at the satisfied head and still holds any other head", () => {
    const store = heldFor("rv-sec");

    const swapped = store.satisfyHold("run-1", "rv-sec", H1, by);

    expect(swapped).toBe(true);
    expect(store.heldReason("octo/demo", 7, undefined, H1)).toBeUndefined();
    expect(store.heldReason("octo/demo", 7, undefined, H2)).toBe("awaiting a named review");
    expect(store.heldReason("octo/demo", 7)).toBe("awaiting a named review");
    expect(store.byRun("run-1")?.holdSatisfied).toEqual({ head: H1, by: { ...by, reviewer: "rv-sec" } });
  });

  it("refuses the swap when the hold names another reviewer or was released", () => {
    const store = heldFor("rv-sec");

    const otherReviewer = store.satisfyHold("run-1", "rv-other", H1, by);
    store.release("run-1");
    const released = store.satisfyHold("run-1", "rv-sec", H1, by);

    expect([otherReviewer, released]).toEqual([false, false]);
    expect(store.byRun("run-1")?.holdSatisfied).toBeNull();
  });

  it("clears the satisfaction on a re-hold, even for the same reviewer", () => {
    const store = heldFor("rv-sec");
    store.satisfyHold("run-1", "rv-sec", H1, by);

    store.hold("run-1", "awaiting another look", "rv-other");

    expect(store.heldReason("octo/demo", 7, undefined, H1)).toBe("awaiting another look");
    expect(store.byRun("run-1")?.holdSatisfied).toBeNull();
  });

  it("withdraws the satisfaction whatever head the FIX_FIRST was read at", () => {
    const store = heldFor("rv-sec");
    store.satisfyHold("run-1", "rv-sec", H1, by);

    store.unsatisfyHold("run-1");

    expect(store.heldReason("octo/demo", 7, undefined, H1)).toBe("awaiting a named review");
  });
});

function openLineageStore(clock: { now: number } = { now: Date.parse("2026-01-01T00:00:00Z") }): ShepherdStore {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)]);
  return new ShepherdStore(db, () => clock.now);
}

const implementer: AuthorInput = { agentId: "agent-1", name: "impl-a", role: "implementer" };
const successor: AuthorInput = { agentId: "agent-2", name: "impl-b", role: "successor", predecessor: "agent-1" };

describe("shepherd lineage", () => {
  it("reads back the authors recorded for a run, with the predecessor of a successor", () => {
    const store = openLineageStore();
    store.recordAuthor("run-1", implementer);
    store.recordAuthor("run-1", successor);

    expect(store.authorsOf("run-1")).toEqual([
      { runId: "run-1", agentId: "agent-1", name: "impl-a", role: "implementer", predecessor: null, at: "2026-01-01T00:00:00.000Z" },
      { runId: "run-1", agentId: "agent-2", name: "impl-b", role: "successor", predecessor: "agent-1", at: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("does not show one run's authors to another run", () => {
    const store = openLineageStore();
    store.recordAuthor("run-1", implementer);
    store.recordAuthor("run-2", successor);

    expect(store.authorsOf("run-2").map((a) => a.agentId)).toEqual(["agent-2"]);
    expect(store.authorsOf("run-3")).toEqual([]);
  });

  it("keeps one row when the same agent is recorded twice", () => {
    const store = openLineageStore();
    store.recordAuthor("run-1", implementer);

    expect(() => store.recordAuthor("run-1", implementer)).not.toThrow();

    expect(store.authorsOf("run-1")).toHaveLength(1);
  });

  it("keeps the first role, predecessor and time when a repeat record differs", () => {
    const clock = { now: Date.parse("2026-01-01T00:00:00Z") };
    const store = openLineageStore(clock);
    store.recordAuthor("run-1", successor);
    clock.now = Date.parse("2026-01-02T00:00:00Z");

    store.recordAuthor("run-1", { agentId: "agent-2", name: "renamed", role: "implementer" });

    expect(store.authorsOf("run-1")).toEqual([
      { runId: "run-1", agentId: "agent-2", name: "impl-b", role: "successor", predecessor: "agent-1", at: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("records the same agent under two runs as two rows", () => {
    const store = openLineageStore();
    store.recordAuthor("run-1", implementer);
    store.recordAuthor("run-2", implementer);

    expect(store.authorsOf("run-1")).toHaveLength(1);
    expect(store.authorsOf("run-2")).toHaveLength(1);
  });

  it("lists authors by time, then agent id", () => {
    const clock = { now: Date.parse("2026-01-02T00:00:00Z") };
    const store = openLineageStore(clock);
    store.recordAuthor("run-1", { agentId: "agent-9", name: "late", role: "successor" });
    clock.now = Date.parse("2026-01-01T00:00:00Z");
    store.recordAuthor("run-1", { agentId: "agent-b", name: "b", role: "successor" });
    store.recordAuthor("run-1", { agentId: "agent-a", name: "a", role: "implementer" });

    expect(store.authorsOf("run-1").map((a) => a.agentId)).toEqual(["agent-a", "agent-b", "agent-9"]);
  });

  it("refuses a role other than implementer or successor", () => {
    const store = openLineageStore();

    expect(() => store.recordAuthor("run-1", Object.assign({ ...implementer }, { role: "reviewer" }))).toThrow(/CHECK/);
  });

  it("keeps every registration when a database that holds them gains the lineage table", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), sliceMigration(8)]);
    const before = new ShepherdStore(db, () => 0);
    before.register(base);
    const rows = db.prepare("SELECT * FROM shepherd_registration").all();

    const applied = runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8)]);

    expect(applied).toEqual([5]);
    expect(appliedVersions(db)).toEqual([4, 5, 8]);
    expect(db.prepare("SELECT * FROM shepherd_registration").all()).toEqual(rows);
    expect(new ShepherdStore(db).byRun("run-1")?.task).toBe("demo/1");
  });
});

describe("shepherd store ref", () => {
  it("throws while unbound, so a guard reading it fails closed", () => {
    expect(() => shepherdStoreRef().get()).toThrow(/not bound/);
  });

  it("refuses a second bind until the first is released", () => {
    const ref = shepherdStoreRef();
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9)]);
    const unbind = ref.bind(db);

    expect(() => ref.bind(db)).toThrow(/already bound/);
    unbind();
    expect(() => ref.get()).toThrow(/not bound/);
  });
});

describe("settled park markers", () => {
  const db = () => {
    const opened = openDatabase(":memory:");
    runMigrations(opened, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), accountLimitMigration(17), holdSlotsMigration(19), parkSettledMigration(21), mergeBaseExceptionMigration(42)]);
    return opened;
  };
  const openWithMarkers = (on = db()) => new ShepherdStore(on, () => Date.parse("2026-01-01T00:00:00Z"));
  const H1 = "a".repeat(40);

  it("finds a settle only at its own run, head and agent", () => {
    const store = openWithMarkers();

    store.settlePark("run-1", H1, "impl-a", { parked: false, detail: "dirty" });

    expect(store.parkSettled("run-1", H1, "impl-a")).toBe(true);
    expect(store.parkSettled("run-1", "b".repeat(40), "impl-a")).toBe(false);
    expect(store.parkSettled("run-1", H1, "impl-b")).toBe(false);
    expect(store.parkSettled("run-2", H1, "impl-a")).toBe(false);
  });

  it("keeps the first settle when the same refusal settles again", () => {
    const opened = db();
    const store = openWithMarkers(opened);

    store.settlePark("run-1", H1, "impl-a", { parked: false, detail: "dirty" });
    store.settlePark("run-1", H1, "impl-a", { parked: true, detail: "parked" });

    const row = opened.prepare("SELECT parked, detail FROM shepherd_park_settled").all();
    expect(row).toEqual([{ parked: 0, detail: "dirty" }]);
  });

  it("moves a settle to the run that replaces its failed one", () => {
    const store = openWithMarkers();
    store.register(base);
    store.settlePark("run-1", H1, "impl-a", { parked: false, detail: "dirty" });

    store.repoint("run-1", "run-2");

    expect(store.parkSettled("run-2", H1, "impl-a")).toBe(true);
    expect(store.parkSettled("run-1", H1, "impl-a")).toBe(false);
  });

  it("applies the settle migration after a gap at version 20", () => {
    const versions = appliedVersions(db());

    expect(versions).toContain(21);
    expect(versions).not.toContain(20);
  });
});
