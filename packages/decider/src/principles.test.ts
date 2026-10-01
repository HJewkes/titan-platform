import { PlaybookStore, applyMaturity, memoryMigration, scorePlaybook } from "@titan-design/memory";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ledgerKeyOf, ledgerRef, principleBullet, principlesByDomain } from "./principles.js";

const NOW = new Date("2026-03-01T00:00:00Z");

describe("principles as memory bullets", () => {
  let db: Db;
  let store: PlaybookStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db, [memoryMigration(1)]);
    store = new PlaybookStore(db, { now: () => NOW });
  });

  afterEach(() => db.close());

  it("stores the domain as the bullet category and the cited ledger keys as provenance", () => {
    const bullet = store.add(principleBullet({ rule: "Prefer a queue over cron", domain: "tech_design", citedKeys: ["note:widgets/a.md", "note:widgets/a.md", "queue:7"] }));

    expect(bullet).toMatchObject({
      content: "Prefer a queue over cron",
      category: "tech_design",
      maturity: "candidate",
      sourceSessions: [{ sessionRef: "ledger:note:widgets/a.md" }, { sessionRef: "ledger:queue:7" }],
    });
  });

  it("rejects a domain that is not a single plain path segment", () => {
    expect(() => principleBullet({ rule: "x", domain: "../escape", citedKeys: [] })).toThrow(/invalid principle domain/);
    expect(() => principleBullet({ rule: "x", domain: "", citedKeys: [] })).toThrow(/invalid principle domain/);
  });

  it("round-trips ledger refs and ignores refs from elsewhere", () => {
    expect(ledgerKeyOf(ledgerRef("transcript:s:t#1"))).toBe("transcript:s:t#1");
    expect(ledgerKeyOf("session:abc")).toBeNull();
    expect(ledgerKeyOf(null)).toBeNull();
  });

  it("derives confidence, last confirmed, examples and counter-examples from the feedback log", () => {
    const { id } = store.add(principleBullet({ rule: "Ship the smaller slice first", domain: "scope_priority", citedKeys: ["note:w/a.md"] }));
    store.recordFeedback(id, "helpful", { sessionRef: ledgerRef("queue:1"), at: "2026-02-01T00:00:00Z" });
    store.recordFeedback(id, "helpful", { sessionRef: ledgerRef("queue:2"), at: "2026-02-10T00:00:00Z" });
    store.recordFeedback(id, "helpful", { sessionRef: ledgerRef("queue:3"), at: "2026-02-20T00:00:00Z" });
    store.recordFeedback(id, "harmful", { sessionRef: ledgerRef("queue:4"), at: "2026-02-25T00:00:00Z" });
    store.recordFeedback(id, "helpful", { sessionRef: "session:not-ledger", at: "2026-02-26T00:00:00Z" });
    applyMaturity(store, NOW);

    const [principle] = principlesByDomain(store, NOW).get("scope_priority") ?? [];

    expect(principle).toMatchObject({
      id,
      maturity: "established",
      lastConfirmed: "2026-02-26T00:00:00Z",
      examples: ["note:w/a.md", "queue:1", "queue:2", "queue:3"],
      counterExamples: ["queue:4"],
    });
    expect(principle?.score).toBe(scorePlaybook(store, NOW)[0]?.effectiveScore);
  });

  it("leaves retired principles out and groups the rest by domain", () => {
    store.add(principleBullet({ rule: "A", domain: "agent_ops", citedKeys: [] }));
    store.add(principleBullet({ rule: "B", domain: "tech_design", citedKeys: [] }));
    const retired = store.add(principleBullet({ rule: "C", domain: "tech_design", citedKeys: [] }));
    store.deprecate(retired.id, "superseded");

    const grouped = principlesByDomain(store, NOW);

    expect([...grouped.keys()].sort()).toEqual(["agent_ops", "tech_design"]);
    expect(grouped.get("tech_design")?.map((p) => p.rule)).toEqual(["B"]);
    expect(grouped.get("agent_ops")?.[0]?.lastConfirmed).toBeNull();
  });
});
