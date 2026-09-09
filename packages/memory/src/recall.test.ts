import { HashEmbedder } from "@titan-design/embed";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keywordScore, recall } from "./recall.js";
import { memoryMigration } from "./schema.js";
import { PlaybookStore } from "./store.js";
import { MemoryVectors } from "./vectors.js";

const T0 = new Date("2026-09-08T12:00:00Z");

describe("keywordScore", () => {
  it("pays three per exact token, one per substring, five per tag", () => {
    expect(keywordScore("Run pnpm lint before pushing", ["ci"], "lint")).toBe(3);
    expect(keywordScore("Run pnpm lint before pushing", ["ci"], "linting")).toBe(0);
    expect(keywordScore("Run pnpm linting before pushing", ["ci"], "lint")).toBe(1);
    expect(keywordScore("Run pnpm lint", ["ci"], "ci")).toBe(5);
    expect(keywordScore("Run pnpm lint", ["ci"], "lint", ["CI"])).toBe(8);
  });
});

describe("recall", () => {
  let db: Db;
  let store: PlaybookStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db, [memoryMigration(1)]);
    store = new PlaybookStore(db, { now: () => T0 });
  });

  afterEach(() => db.close());

  it("ranks topical bullets by relevance times floored confidence", async () => {
    const trusted = store.add({ id: "b-trusted", content: "Run pnpm lint before pushing" });
    const novice = store.add({ id: "b-novice", content: "Run pnpm lint after rebasing" });
    store.add({ id: "b-off", content: "Prefer tabs in Makefiles" });
    for (let i = 0; i < 12; i++) store.recordFeedback(trusted.id, "helpful");
    store.update(trusted.id, { maturity: "proven" });
    const result = await recall(store, "pnpm lint", { now: T0 });
    expect(result.bullets.map((b) => b.id)).toEqual([trusted.id, novice.id]);
    expect(result.bullets[0]?.finalScore).toBeGreaterThan(result.bullets[1]!.finalScore);
    expect(result.bullets[1]?.finalScore).toBeCloseTo(6 * 0.1);
    expect(result.degraded).toEqual([]);
  });

  it("splits anti-patterns and retired bullets out of the main list", async () => {
    store.add({ id: "b-rule", content: "Squash commits before merge" });
    store.add({ id: "b-avoid", content: "AVOID: squash commits on shared branches", isNegative: true });
    const old = store.add({ id: "b-old", content: "Squash commits with git merge --squash" });
    store.deprecate(old.id, "replaced");
    const result = await recall(store, "squash commits", { now: T0 });
    expect(result.bullets.map((b) => b.id)).toEqual(["b-rule"]);
    expect(result.antiPatterns.map((b) => b.id)).toEqual(["b-avoid"]);
    expect(result.deprecatedWarnings.map((b) => b.id)).toEqual(["b-old"]);
  });

  it("filters by scope, keeping global bullets", async () => {
    store.add({ id: "b-global", content: "Write tests", scope: "global" });
    store.add({ id: "b-ts", content: "Write tests in vitest", scope: "framework" });
    store.add({ id: "b-py", content: "Write tests in pytest", scope: "language" });
    const result = await recall(store, "write tests", { scope: "framework", now: T0 });
    expect(result.bullets.map((b) => b.id).sort()).toEqual(["b-global", "b-ts"]);
  });

  it("blends vector similarity in when a semantic index is supplied", async () => {
    const embedder = new HashEmbedder({ dimensions: 64 });
    store.add({ id: "b-a", content: "Prefer small pull requests" });
    store.add({ id: "b-b", content: "Water the plants weekly" });
    const index = await new MemoryVectors(db, embedder).index(store.list());
    const result = await recall(store, "small pull requests", { now: T0, semantic: { embedder, index } });
    expect(result.degraded).toEqual([]);
    expect(result.bullets.map((b) => b.id)).toEqual(["b-a"]);
    expect(result.bullets[0]?.semanticScore).toBeGreaterThan(0);
  });

  it("reports degradation and falls back to keywords when the embedder fails", async () => {
    store.add({ id: "b-a", content: "Prefer small pull requests" });
    const embedder = { model: "broken", dimensions: 1, embed: async () => Promise.reject(new Error("offline")) };
    const index = { search: async () => [] };
    const result = await recall(store, "small pull requests", { now: T0, semantic: { embedder, index } });
    expect(result.degraded).toEqual([{ retriever: "memory-vector", reason: "error", message: "offline" }]);
    expect(result.bullets.map((b) => b.id)).toEqual(["b-a"]);
    expect(result.bullets[0]?.semanticScore).toBeNull();
  });
});

describe("MemoryVectors", () => {
  it("embeds misses once and serves the rest from cache", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [memoryMigration(1)]);
    const store = new PlaybookStore(db);
    const calls: string[][] = [];
    const inner = new HashEmbedder({ dimensions: 32 });
    const embedder = { model: inner.model, dimensions: inner.dimensions, embed: async (texts: string[]) => (calls.push(texts), inner.embed(texts)) };
    const vectors = new MemoryVectors(db, embedder);
    store.add({ content: "one" });
    store.add({ content: "two" });
    expect(await vectors.ensure(store.list())).toBe(2);
    store.add({ content: "ONE" });
    store.add({ content: "three" });
    expect(await vectors.ensure(store.list())).toBe(1);
    expect(calls.map((batch) => [...batch].sort())).toEqual([["one", "two"], ["three"]]);
    db.close();
  });
});
