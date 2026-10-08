import { PlaybookStore, memoryMigration } from "@titan-design/memory";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { condense, condenseWatermarks, type CondenseStore, type Reflector, type ReflectorInput } from "./condense.js";
import { extractSource } from "./extract.js";
import { POLICY, v1Row } from "./fixtures.js";
import { LedgerRowSchema, type LedgerRow, type LedgerRowWire } from "./ledger.js";
import { principleBullet } from "./principles.js";
import type { LedgerSource } from "./source.js";
import { LedgerStore, type LedgerEntry } from "./store.js";

const NOW = new Date("2026-03-01T00:00:00Z");

let seq = 0;
function row(overrides: Partial<LedgerRowWire> = {}): LedgerRow {
  seq++;
  return LedgerRowSchema.parse(
    v1Row({ key: `queue:${String(seq).padStart(3, "0")}`, answered_at: `2026-02-${String(seq).padStart(2, "0")}T00:00:00Z`, ...overrides }),
  );
}

/** One answer that took a whole plan's recommendations at once. */
function bulkRow(): LedgerRow {
  return row({ recommended: "Accept the 6 defaults (recommended)", answer: "Accept the 6 defaults" });
}

function scripted(...outputs: unknown[]): Reflector & { calls: ReflectorInput[] } {
  const calls: ReflectorInput[] = [];
  const fn = vi.fn(async (input: ReflectorInput) => {
    calls.push(input);
    return outputs.shift() ?? [];
  });
  return Object.assign(fn, { calls });
}

describe("condense over bulk answers", () => {
  let db: Db;
  let store: CondenseStore;
  let ledger: LedgerStore;

  beforeEach(() => {
    seq = 0;
    db = openDatabase(":memory:");
    runMigrations(db, [memoryMigration(1)]);
    store = { playbook: new PlaybookStore(db, { now: () => NOW }), watermarks: condenseWatermarks(db) };
    ledger = new LedgerStore(db);
  });

  afterEach(() => db.close());

  function ingest(rows: readonly LedgerRow[]): LedgerEntry[] {
    ledger.append(rows as LedgerRowWire[]);
    return ledger.entries();
  }

  it("never shows the reflector a bulk answer, and counts it on the domain run", async () => {
    const [bulk, owner] = [bulkRow(), row()];
    const reflector = scripted();

    const result = await condense(store, ingest([bulk, owner]), reflector, { now: NOW });

    expect(bulk.outcome).toBe("bulk");
    expect(reflector.calls.map((c) => c.rows.map((r) => r.key))).toEqual([[owner.key]]);
    expect(result.domains).toEqual([expect.objectContaining({ domain: "tech_design", rows: 2, evidence: 1, bulk: 1 })]);
  });

  it("rejects a cite on a bulk answer and records no feedback for it", async () => {
    const principle = store.playbook.add(principleBullet({ rule: "Prefer a queue over cron", domain: "tech_design", citedKeys: ["queue:seed"] }));
    const [bulk, owner] = [bulkRow(), row()];
    const reflector = scripted([{ type: "cite", rowKey: bulk.key, principleId: principle.id, verdict: "agrees" }]);

    const result = await condense(store, ingest([bulk, owner]), reflector, { now: NOW });

    expect(result.domains[0]?.rejected).toEqual([{ domain: "tech_design", index: 0, reason: `row ${bulk.key} is not owner evidence in this batch` }]);
    expect(result.feedback).toEqual([]);
    expect(store.playbook.feedbackFor(principle.id)).toEqual([]);
  });

  it("adds no bullet for 'the owner accepts the default' grounded only in bulk answers", async () => {
    const bulks = [bulkRow(), bulkRow(), bulkRow()];
    const owner = row();
    const reflector = scripted([{ type: "propose", rule: "The owner accepts the default", citedKeys: bulks.map((b) => b.key) }]);

    const result = await condense(store, ingest([...bulks, owner]), reflector, { now: NOW });

    expect(result.added).toEqual([]);
    expect(store.playbook.list()).toEqual([]);
    expect(result.domains[0]?.rejected).toEqual([
      { domain: "tech_design", index: 0, reason: `cited row ${bulks[0]?.key} is not owner evidence in this batch` },
    ]);
  });

  it("advances the domain watermark past bulk answers without calling the reflector", async () => {
    const reflector = scripted();
    const entries = ingest([bulkRow(), bulkRow()]);

    const result = await condense(store, entries, reflector, { now: NOW });
    const again = await condense(store, ingest([]), reflector, { now: NOW });

    expect(reflector.calls).toEqual([]);
    expect(result.domains).toEqual([expect.objectContaining({ rows: 2, evidence: 0, bulk: 2 })]);
    expect(store.watermarks.get("condense:tech_design")?.lastOffset).toBe(entries[entries.length - 1]?.seq);
    expect(again.domains).toEqual([]);
  });

  it("still learns from a per-item redirect carved out of a bulk answer", async () => {
    const principle = store.playbook.add(principleBullet({ rule: "Prefer a queue over cron", domain: "tech_design", citedKeys: ["queue:seed"] }));
    const carveOut = row({ answer: "Not accepted: use a cron job here; accept all the other defaults", pick_type: "free_text" });
    const reflector = scripted([{ type: "cite", rowKey: carveOut.key, principleId: principle.id, verdict: "contradicts" }]);

    const result = await condense(store, ingest([bulkRow(), carveOut]), reflector, { now: NOW });

    expect(carveOut.outcome).toBe("redirect");
    expect(result.domains[0]).toMatchObject({ evidence: 1, bulk: 1, rejected: [] });
    expect(store.playbook.feedbackFor(principle.id)).toEqual([expect.objectContaining({ type: "harmful", sessionRef: `ledger:${carveOut.key}` })]);
  });
});

describe("extractSource with a bulk answer", () => {
  it("writes the bulk row, so it authorizes its items and a stale sweep finds it, and counts it", async () => {
    const db = openDatabase(":memory:");
    const ledger = new LedgerStore(db);
    const bulk = v1Row({ key: "transcript:sess-0001:toolu_bulk", recommended: "Accept the 6 defaults (recommended)", answer: "Accept the 6 defaults" });
    const single = v1Row({ key: "transcript:sess-0001:toolu_single" });
    const source: LedgerSource = {
      name: "transcript",
      read: async () => ({ candidates: [bulk, single].map((r) => ({ row: r, cwd: null })), watermarks: new Map(), pending: 0, errors: [] }),
    };

    const summary = await extractSource(ledger, source, POLICY);

    expect(summary).toMatchObject({ read: 2, written: 2, bulk: 1 });
    expect(ledger.get(bulk.key)?.outcome).toBe("bulk");
    db.close();
  });
});
