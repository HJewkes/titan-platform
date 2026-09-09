import { EdgeTable, openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMaturity, scorePlaybook, staleBullets } from "./playbook.js";
import { DEFAULT_MEMORY_TABLES, memoryMigration } from "./schema.js";
import { BulletNotFound, PlaybookStore, bulletRef } from "./store.js";

const T0 = new Date("2026-09-08T12:00:00Z");

function daysAgo(days: number): string {
  return new Date(T0.getTime() - days * 86_400_000).toISOString();
}

describe("PlaybookStore", () => {
  let db: Db;
  let store: PlaybookStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db, [memoryMigration(1)]);
    store = new PlaybookStore(db, { now: () => T0 });
  });

  afterEach(() => db.close());

  it("adds a bullet with defaults and reads it back", () => {
    const bullet = store.add({ content: "Run the linter before committing", tags: ["git"] });
    expect(bullet.id).toMatch(/^b-/);
    expect(store.get(bullet.id)).toEqual({
      ...bullet,
      state: "active",
      maturity: "candidate",
      type: "rule",
      kind: "workflow_rule",
      scope: "workspace",
      halfLifeDays: 90,
      createdAt: T0.toISOString(),
    });
  });

  it("derives the anti-pattern type and kind from isNegative", () => {
    const bullet = store.add({ content: "AVOID: force-push to main", isNegative: true });
    expect(bullet).toMatchObject({ type: "anti-pattern", kind: "anti_pattern" });
  });

  it("returns undefined for an unknown id and throws on require", () => {
    expect(store.get("nope")).toBeUndefined();
    expect(() => store.require("nope")).toThrow(BulletNotFound);
  });

  it("lists live bullets by id and hides retired ones unless asked", () => {
    const a = store.add({ id: "b-a", content: "first" });
    const b = store.add({ id: "b-b", content: "second" });
    store.deprecate(a.id, "obsolete");
    expect(store.list().map((x) => x.id)).toEqual([b.id]);
    expect(store.list({ includeRetired: true }).map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it("records deprecation and asserts a supersedes edge when replaced", () => {
    const old = store.add({ id: "b-old", content: "use npm" });
    const next = store.add({ id: "b-new", content: "use pnpm" });
    const retired = store.deprecate(old.id, "replaced", next.id);
    expect(retired).toMatchObject({ state: "retired", maturity: "deprecated", replacedBy: next.id, deprecationReason: "replaced", deprecatedAt: T0.toISOString() });
    expect(store.supersededBy(next.id)).toEqual([old.id]);
    const edges = new EdgeTable(db, { name: DEFAULT_MEMORY_TABLES.edge }).from(bulletRef(next.id));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ relation: "supersedes", targetRef: bulletRef(old.id) });
  });

  it("appends feedback and never mutates earlier events", () => {
    const bullet = store.add({ content: "x" });
    const first = store.recordFeedback(bullet.id, "helpful", { sessionRef: "session:s1", at: daysAgo(1) });
    store.recordFeedback(bullet.id, "harmful", { reason: "misled me" });
    expect(store.feedbackFor(bullet.id)).toEqual([
      first,
      expect.objectContaining({ type: "harmful", reason: "misled me", at: T0.toISOString() }),
    ]);
    expect(() => store.recordFeedback("nope", "helpful")).toThrow(BulletNotFound);
  });

  it("groups all feedback by bullet in one query", () => {
    const a = store.add({ id: "b-a", content: "a" });
    const b = store.add({ id: "b-b", content: "b" });
    store.recordFeedback(a.id, "helpful");
    store.recordFeedback(b.id, "harmful");
    store.recordFeedback(a.id, "helpful");
    const grouped = store.feedbackByBulletId();
    expect(grouped.get(a.id)?.map((e) => e.type)).toEqual(["helpful", "helpful"]);
    expect(grouped.get(b.id)?.map((e) => e.type)).toEqual(["harmful"]);
  });

  it("keeps blocked patterns separate from bullets", () => {
    store.block("rewrite history on shared branches", "human veto");
    expect(store.blockedPatterns()).toEqual([{ pattern: "rewrite history on shared branches", reason: "human veto", blockedAt: T0.toISOString() }]);
    expect(store.list()).toEqual([]);
  });

  it("updates fields and stamps updatedAt", () => {
    const bullet = store.add({ content: "x" });
    const later = new Date(T0.getTime() + 1000);
    const updated = new PlaybookStore(db, { now: () => later }).update(bullet.id, { pinned: true, pinnedReason: "policy" });
    expect(updated).toMatchObject({ pinned: true, pinnedReason: "policy", updatedAt: later.toISOString(), createdAt: T0.toISOString() });
  });
});

describe("scoring the playbook", () => {
  let db: Db;
  let store: PlaybookStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db, [memoryMigration(1)]);
    store = new PlaybookStore(db, { now: () => T0 });
  });

  afterEach(() => db.close());

  it("scores from decayed feedback and reports last evidence", () => {
    const bullet = store.add({ content: "x" });
    store.recordFeedback(bullet.id, "helpful", { at: daysAgo(90) });
    store.recordFeedback(bullet.id, "helpful", { at: daysAgo(0) });
    const [scored] = scorePlaybook(store, T0);
    expect(scored).toMatchObject({ helpfulCount: 2, harmfulCount: 0, lastEvidenceAt: T0.toISOString() });
    expect(scored?.decayedHelpful).toBeCloseTo(1.5);
    expect(scored?.effectiveScore).toBeCloseTo(0.75);
  });

  it("promotes, demotes one rung, and retires below the floor", () => {
    const rising = store.add({ id: "b-rise", content: "rise" });
    const falling = store.add({ id: "b-fall", content: "fall" });
    const toxic = store.add({ id: "b-toxic", content: "toxic" });
    for (let i = 0; i < 12; i++) store.recordFeedback(rising.id, "helpful");
    store.update(falling.id, { maturity: "proven" });
    for (let i = 0; i < 3; i++) store.recordFeedback(toxic.id, "harmful");
    const changes = applyMaturity(store, T0);
    expect(changes).toEqual([
      { bulletId: falling.id, from: "proven", to: "established" },
      { bulletId: rising.id, from: "candidate", to: "proven" },
      { bulletId: toxic.id, from: "candidate", to: "deprecated" },
    ]);
    expect(store.get(toxic.id)).toMatchObject({ state: "retired", maturity: "deprecated" });
  });

  it("flags stale bullets by silence and skips pinned ones", () => {
    const quiet = store.add({ id: "b-quiet", content: "quiet" });
    const pinned = store.add({ id: "b-pin", content: "pinned", pinned: true });
    const fresh = store.add({ id: "b-fresh", content: "fresh" });
    store.recordFeedback(quiet.id, "helpful", { at: daysAgo(200) });
    store.recordFeedback(pinned.id, "helpful", { at: daysAgo(200) });
    store.recordFeedback(fresh.id, "helpful", { at: daysAgo(10) });
    const later = new Date(T0.getTime() + 200 * 86_400_000);
    expect(staleBullets(store, later).map((b) => b.id)).toEqual([fresh.id, quiet.id]);
    expect(staleBullets(store, T0).map((b) => b.id)).toEqual([quiet.id]);
  });
});
