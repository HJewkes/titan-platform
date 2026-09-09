import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { curate } from "./curate.js";
import { memoryMigration } from "./schema.js";
import { PlaybookStore } from "./store.js";

const T0 = new Date("2026-09-08T12:00:00Z");
const PROVENANCE = { sessionRef: "session:s1", byteOffset: 4096 };

describe("curate", () => {
  let db: Db;
  let store: PlaybookStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db, [memoryMigration(1)]);
    store = new PlaybookStore(db, { now: () => T0 });
  });

  afterEach(() => db.close());

  it("adds a new bullet and stamps provenance from the curator, not the delta", () => {
    const report = curate(store, [{ type: "add", content: "Run pnpm lint before pushing", category: "workflow", tags: ["ci"] }], { provenance: PROVENANCE, now: () => T0 });
    expect(report.added).toHaveLength(1);
    expect(store.get(report.added[0]!)).toMatchObject({ content: "Run pnpm lint before pushing", category: "workflow", tags: ["ci"], sourceSessions: [PROVENANCE] });
  });

  it("collapses duplicate adds within a batch", () => {
    const report = curate(store, [
      { type: "add", content: "Use pnpm" },
      { type: "add", content: "use  PNPM" },
    ]);
    expect(report.added).toHaveLength(1);
    expect(report.skipped).toEqual([{ delta: expect.objectContaining({ type: "add", content: "use  PNPM" }), reason: "duplicate delta" }]);
  });

  it("folds an exact or near-duplicate add into helpful feedback on the existing bullet", () => {
    const existing = store.add({ content: "Always run the full test suite before opening a pull request" });
    const report = curate(store, [
      { type: "add", content: "always run the full test suite before opening a pull request" },
      { type: "add", content: "Always run the full test suite before opening a pull request please" },
    ], { provenance: PROVENANCE });
    expect(report.added).toEqual([]);
    expect(report.reinforced).toEqual([existing.id, existing.id]);
    expect(store.feedbackFor(existing.id).map((e) => e.sessionRef)).toEqual(["session:s1", "session:s1"]);
  });

  it("refuses to re-learn a blocked pattern", () => {
    store.block("force push to main to fix history", "human veto");
    const report = curate(store, [{ type: "add", content: "Force push to main to fix history" }]);
    expect(report.blocked).toEqual(["Force push to main to fix history"]);
    expect(store.list()).toEqual([]);
  });

  it("records feedback and skips unknown bullets", () => {
    const bullet = store.add({ content: "x" });
    const report = curate(store, [
      { type: "helpful", bulletId: bullet.id, reason: "saved a retry" },
      { type: "harmful", bulletId: bullet.id },
      { type: "helpful", bulletId: "ghost" },
    ]);
    expect(report.reinforced).toEqual([bullet.id]);
    expect(report.penalized).toEqual([bullet.id]);
    expect(report.skipped).toEqual([{ delta: { type: "helpful", bulletId: "ghost" }, reason: "unknown bullet" }]);
  });

  it("replaces by adding a successor and retiring the original with a supersedes edge", () => {
    const old = store.add({ content: "Use npm ci", tags: ["node"], scope: "global", sourceSessions: [{ sessionRef: "session:s0" }] });
    const report = curate(store, [{ type: "replace", bulletId: old.id, content: "Use pnpm install --frozen-lockfile" }], { provenance: PROVENANCE });
    const next = store.get(report.added[0]!);
    expect(next).toMatchObject({ content: "Use pnpm install --frozen-lockfile", tags: ["node"], scope: "global", sourceSessions: [{ sessionRef: "session:s0" }, PROVENANCE] });
    expect(store.get(old.id)).toMatchObject({ state: "retired", replacedBy: next?.id });
    expect(report.deprecated).toEqual([old.id]);
  });

  it("merges several bullets into one successor", () => {
    const a = store.add({ id: "b-a", content: "lint first", tags: ["lint"] });
    const b = store.add({ id: "b-b", content: "typecheck first", tags: ["tsc"] });
    const report = curate(store, [{ type: "merge", bulletIds: [a.id, b.id], content: "lint and typecheck first" }]);
    const merged = store.get(report.added[0]!);
    expect(merged?.tags).toEqual(["lint", "tsc"]);
    expect(store.supersededBy(merged!.id)).toEqual([a.id, b.id]);
    expect(report.deprecated).toEqual([a.id, b.id]);
  });

  it("deprecates with a reason", () => {
    const bullet = store.add({ content: "x" });
    curate(store, [{ type: "deprecate", bulletId: bullet.id, reason: "no longer true" }]);
    expect(store.get(bullet.id)).toMatchObject({ state: "retired", deprecationReason: "no longer true" });
  });

  it("warns about similar wording with opposite polarity without blocking", () => {
    const existing = store.add({ content: "Commit generated files to the repo" });
    const report = curate(store, [{ type: "add", content: "Never commit generated files to the repo" }]);
    expect(report.added).toHaveLength(1);
    expect(report.conflicts).toEqual([{ bulletId: report.added[0], otherId: existing.id, reason: "similar wording with opposite polarity" }]);
  });

  it("inverts a rule that keeps hurting into an AVOID anti-pattern", () => {
    const rule = store.add({ content: "Retry flaky tests until green", tags: ["ci"] });
    for (let i = 0; i < 3; i++) store.recordFeedback(rule.id, "harmful");
    store.recordFeedback(rule.id, "helpful");
    const report = curate(store, [], { provenance: PROVENANCE, now: () => T0 });
    expect(report.inverted).toHaveLength(1);
    const avoid = store.get(report.inverted[0]!.to);
    expect(avoid).toMatchObject({ content: "AVOID: Retry flaky tests until green", isNegative: true, type: "anti-pattern", kind: "anti_pattern", tags: ["ci"], state: "active" });
    expect(store.get(rule.id)).toMatchObject({ state: "retired", replacedBy: avoid?.id });
  });

  it("leaves a pinned rule alone however harmful the feedback", () => {
    const rule = store.add({ content: "x", pinned: true });
    for (let i = 0; i < 5; i++) store.recordFeedback(rule.id, "harmful");
    const report = curate(store, [], { now: () => T0 });
    expect(report.inverted).toEqual([]);
    expect(report.maturityChanges).toEqual([]);
    expect(store.get(rule.id)?.state).toBe("active");
  });

  it("counts one vote per bullet per batch, then runs the maturity pass", () => {
    const bullet = store.add({ content: "x" });
    for (let i = 0; i < 9; i++) store.recordFeedback(bullet.id, "helpful");
    const deltas = Array.from({ length: 5 }, () => ({ type: "helpful" as const, bulletId: bullet.id }));
    const report = curate(store, deltas, { now: () => T0 });
    expect(report.reinforced).toEqual([bullet.id]);
    expect(report.skipped).toHaveLength(4);
    expect(report.maturityChanges).toEqual([{ bulletId: bullet.id, from: "candidate", to: "proven" }]);
  });
});
