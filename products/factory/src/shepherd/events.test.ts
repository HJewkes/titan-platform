import { appliedVersions, openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { eventsSince, shepherdEventMigration } from "./events.js";
import { FreezeStore, freezeCancelOnlyMigration, freezeMigration } from "./freeze.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, shepherdMigration, sliceMigration } from "./store.js";
import { timelineEntries } from "./view.js";

const REPO = "octo/demo";
const STAMP = Date.parse("2026-01-01T00:00:00Z");

function open(): { db: Db; store: ShepherdStore; freezes: FreezeStore } {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), freezeMigration(6), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), freezeCancelOnlyMigration(12), shepherdEventMigration(15)]);
  const store = new ShepherdStore(db, () => STAMP);
  store.register({ repo: REPO, pr: 7, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return { db, store, freezes: new FreezeStore(db, () => STAMP) };
}

describe("shepherd event history", () => {
  it("writes one hold event with its reason, actor and head", () => {
    const { db, store } = open();

    store.hold("run-1", "waiting on g10-review", undefined, { actor: "coord", headSha: "abc123" });

    expect(eventsSince(db)).toEqual([
      { runId: "run-1", repo: REPO, pr: 7, kind: "hold", reason: "waiting on g10-review", actor: "coord", at: "2026-01-01T00:00:00.000Z", headSha: "abc123" },
    ]);
  });

  it("writes one release event per release and keeps the earlier hold", () => {
    const { db, store } = open();
    store.hold("run-1", "r1");

    store.release("run-1");
    store.hold("run-1", "r2");

    expect(eventsSince(db).map((event) => [event.kind, event.reason])).toEqual([["hold", "r1"], ["release", null], ["hold", "r2"]]);
  });

  it("writes a release event when a compare-and-swap release succeeds, and none when it does not", () => {
    const { db, store } = open();
    store.hold("run-1", "r1");

    expect(store.releaseIfHeld("run-1", "other")).toBe(false);
    expect(store.releaseIfHeld("run-1", "r1")).toBe(true);

    expect(eventsSince(db).map((event) => event.kind)).toEqual(["hold", "release"]);
  });

  it("writes no event when the state change fails", () => {
    const { db, store } = open();

    expect(() => store.hold("missing", "r1")).toThrow(/no registration/);
    expect(() => store.release("missing")).toThrow(/no registration/);

    expect(eventsSince(db)).toEqual([]);
  });

  it("rolls the state change back when the event cannot be written", () => {
    const { db, store } = open();
    db.exec("DROP TABLE shepherd_event");

    expect(() => store.hold("run-1", "r1")).toThrow();

    expect(store.byRun("run-1")?.held).toBe(false);
  });

  it("writes a freeze event for a new episode and a thaw event for its release, not for a repeat red", () => {
    const { db, freezes } = open();

    freezes.freeze(REPO, "red1");
    freezes.freeze(REPO, "red1");
    freezes.freeze(REPO, "red2");
    freezes.release(REPO, 1);

    expect(eventsSince(db).map((event) => [event.kind, event.runId, event.pr, event.headSha])).toEqual([
      ["freeze", null, null, "red1"],
      ["thaw", null, null, "red2"],
    ]);
  });

  it("writes no thaw event for a stale episode", () => {
    const { db, freezes } = open();
    freezes.freeze(REPO, "red1");

    expect(freezes.release(REPO, 9)).toBe(false);

    expect(eventsSince(db).map((event) => event.kind)).toEqual(["freeze"]);
  });

  it("shows a run's hold events and its repo's freeze events in the timeline, oldest first", () => {
    const { store, freezes } = open();
    store.hold("run-1", "r1", undefined, { actor: "coord" });
    freezes.freeze(REPO, "red1");
    store.release("run-1");

    const run = { activeSteps: {}, stepResults: {} } as never;
    const entries = timelineEntries(run, [], store.eventsOf("run-1"));

    expect(entries.map((entry) => entry.kind === "event" && entry.event)).toEqual(["hold", "freeze", "release"]);
  });

  it("applies the migration once and leaves other tables alone", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), shepherdEventMigration(15)]);

    expect(runMigrations(db, [shepherdMigration(4), shepherdEventMigration(15)])).toEqual([]);
    expect(appliedVersions(db)).toContain(15);
  });
});
