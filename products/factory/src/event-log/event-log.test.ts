import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appliedVersions, openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { appendEvent, eventLogMigration, headSeq, MAX_PAYLOAD_BYTES, readEvents, type IdentityEvent, type TransitionEvent } from "./event-log.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const OBSERVED = "2026-10-17T12:00:00.000Z";

function db(): Db {
  const opened = openDatabase(":memory:");
  runMigrations(opened, [eventLogMigration()]);
  return opened;
}

function ci(overrides: Partial<IdentityEvent> = {}): IdentityEvent {
  return {
    rule: "identity",
    source: "webhook",
    kind: "CIConcluded",
    repo: "o/r",
    subject: `o/r@${SHA_A}`,
    keys: { context: "build", state: "success" },
    occurrenceKey: `v1|CIConcluded|o/r|status|${SHA_A}|build|success|2026-10-17T11:59:00Z`,
    observedAt: OBSERVED,
    payload: { context: "build" },
    ...overrides,
  };
}

function head(value: string, overrides: Partial<TransitionEvent> = {}): TransitionEvent {
  return {
    rule: "transition",
    source: "backstop",
    kind: "HeadPushed",
    repo: "o/r",
    subject: "o/r#7",
    keys: { pr: 7 },
    keyBase: `v1|HeadPushed|o/r|o/r#7|${value}`,
    value,
    observedAt: OBSERVED,
    payload: {},
    ...overrides,
  };
}

describe("event log migration", () => {
  it("aborts every UPDATE and DELETE of a row", () => {
    const log = db();
    appendEvent(log, ci());

    expect(() => log.prepare("UPDATE factory_event SET kind = 'x'").run()).toThrow(/append-only/);
    expect(() => log.prepare("DELETE FROM factory_event").run()).toThrow(/append-only/);
    expect(headSeq(log)).toBe(1);
  });

  it("aborts a REPLACE that clashes on seq, delivery id or occurrence key, and keeps the row", () => {
    const log = db();
    appendEvent(log, ci({ deliveryId: "webhook:d1" }));
    const columns = "(seq, source, kind, subject, keys, delivery_id, occurrence_key, observed_at, payload)";
    const replace = (verb: string, seq: number | null, delivery: string | null, key: string) => () =>
      log.prepare(`${verb} INTO factory_event ${columns} VALUES (?, 'store', 'k', 's', '{}', ?, ?, ?, '{}')`).run(seq, delivery, key, OBSERVED);

    expect(replace("REPLACE", 1, null, "fresh")).toThrow(/append-only/);
    expect(replace("INSERT OR REPLACE", null, "webhook:d1", "fresh")).toThrow(/append-only/);
    expect(replace("REPLACE", null, null, ci().occurrenceKey)).toThrow(/append-only/);
    expect(readEvents(log, { repo: "o/r", sinceSeq: 0 })).toMatchObject([{ seq: 1, deliveryId: "webhook:d1", kind: "CIConcluded" }]);
    expect(headSeq(log)).toBe(1);
  });

  it("admits only the five sources", () => {
    const insert = db().prepare("INSERT INTO factory_event (source, kind, subject, keys, occurrence_key, observed_at, payload) VALUES (?, 'k', 's', '{}', 'o', ?, '{}')");

    expect(() => insert.run("events-api", OBSERVED)).toThrow(/CHECK constraint/);
    expect(insert.run("merge-log", OBSERVED).changes).toBe(1);
  });

  it("applies after a gap below it, and the version below still applies later", () => {
    const opened = openDatabase(":memory:");
    const merge = { version: 29, name: "earlier-29", up: () => undefined };

    runMigrations(opened, [{ version: 28, name: "earlier", up: () => undefined }, eventLogMigration()]);
    const later = runMigrations(opened, [{ version: 28, name: "earlier", up: () => undefined }, merge, eventLogMigration()]);

    expect(later).toEqual([29]);
    expect(appliedVersions(opened)).toEqual([28, 29, 30]);
  });
});

describe("appendEvent", () => {
  it("returns the first row's seq for a repeated delivery id, before any key is read", () => {
    const log = db();
    const first = appendEvent(log, ci({ deliveryId: "webhook:d1" }));

    const again = appendEvent(log, ci({ deliveryId: "webhook:d1", occurrenceKey: "different" }));

    expect(first).toEqual({ inserted: true, seq: 1 });
    expect(again).toEqual({ inserted: false, seq: 1, by: "delivery" });
  });

  it("returns the first row's seq for a repeated occurrence key from another source", () => {
    const log = db();
    appendEvent(log, ci({ deliveryId: "webhook:d1" }));

    const backstop = appendEvent(log, ci({ source: "backstop" }));

    expect(backstop).toEqual({ inserted: false, seq: 1, by: "occurrence" });
    expect(headSeq(log)).toBe(1);
  });

  it("admits many rows with no delivery id", () => {
    const log = db();

    appendEvent(log, ci());
    const second = appendEvent(log, ci({ occurrenceKey: "v1|CIConcluded|o/r|other" }));

    expect(second).toEqual({ inserted: true, seq: 2 });
  });

  it("skips an unchanged transition value and inserts A, B, A again with after:<seq> keys", () => {
    const log = db();

    const results = [appendEvent(log, head(SHA_A)), appendEvent(log, head(SHA_A)), appendEvent(log, head(SHA_B)), appendEvent(log, head(SHA_A))];

    expect(results).toEqual([
      { inserted: true, seq: 1 },
      { inserted: false, seq: 1, by: "unchanged" },
      { inserted: true, seq: 2 },
      { inserted: true, seq: 3 },
    ]);
    const keys = readEvents(log, { subject: "o/r#7", sinceSeq: 0 }).map((row) => row.occurrenceKey);
    expect(keys).toEqual([`v1|HeadPushed|o/r|o/r#7|${SHA_A}|after:0`, `v1|HeadPushed|o/r|o/r#7|${SHA_B}|after:1`, `v1|HeadPushed|o/r|o/r#7|${SHA_A}|after:2`]);
  });

  it("compares a transition against the subject's last row of its own kind only", () => {
    const log = db();
    appendEvent(log, head(SHA_A));
    appendEvent(log, ci({ subject: "o/r#7", kind: "PRClosed", occurrenceKey: "v1|PRClosed|o/r|7|t" }));

    const repeat = appendEvent(log, head(SHA_A));

    expect(repeat).toEqual({ inserted: false, seq: 1, by: "unchanged" });
  });

  it("refuses a payload over the cap and writes nothing", () => {
    const log = db();

    expect(() => appendEvent(log, ci({ payload: "x".repeat(MAX_PAYLOAD_BYTES) }))).toThrow(RangeError);
    expect(headSeq(log)).toBe(0);
  });
});

describe("headSeq and readEvents", () => {
  it("reads 0 from an empty log", () => {
    expect(headSeq(db())).toBe(0);
  });

  it("returns only rows above a captured head, interleaved with writes, in seq order", () => {
    const log = db();
    appendEvent(log, ci());
    const captured = headSeq(log);
    appendEvent(log, ci({ occurrenceKey: "k2", subject: `o/r@${SHA_B}` }));
    const firstRead = readEvents(log, { repo: "o/r", sinceSeq: captured });
    appendEvent(log, ci({ occurrenceKey: "k3" }));
    appendEvent(log, ci({ occurrenceKey: "k4", repo: "o/other", subject: `o/other@${SHA_A}` }));

    const secondRead = readEvents(log, { repo: "o/r", sinceSeq: captured });

    expect(firstRead.map((row) => row.seq)).toEqual([2]);
    expect(secondRead.map((row) => row.seq)).toEqual([2, 3]);
    expect(readEvents(log, { subject: `o/r@${SHA_A}`, sinceSeq: 0 }).map((row) => row.seq)).toEqual([1, 3]);
  });

  it("caps a read at the limit and filters by kind", () => {
    const log = db();
    for (const key of ["k1", "k2", "k3"]) appendEvent(log, ci({ occurrenceKey: key }));
    appendEvent(log, head(SHA_A, { subject: `o/r@${SHA_A}` }));

    expect(readEvents(log, { subject: `o/r@${SHA_A}`, sinceSeq: 0, limit: 2 }).map((row) => row.seq)).toEqual([1, 2]);
    expect(readEvents(log, { subject: `o/r@${SHA_A}`, sinceSeq: 0, kind: "HeadPushed" }).map((row) => row.seq)).toEqual([4]);
  });

  it("returns a row's stored fields parsed", () => {
    const log = db();
    appendEvent(log, ci({ deliveryId: "webhook:d1", sourceAt: "2026-10-17T11:59:00Z" }));

    const [row] = readEvents(log, { subject: `o/r@${SHA_A}`, sinceSeq: 0 });

    expect(row).toMatchObject({ source: "webhook", repo: "o/r", deliveryId: "webhook:d1", sourceAt: "2026-10-17T11:59:00Z", keys: { state: "success" }, payload: { context: "build" } });
  });
});

describe("two writers on one file", () => {
  it("waits out a writer holding the lock, then names its row as the occurrence", () => {
    const dir = mkdtempSync(join(tmpdir(), "event-log-"));
    const path = join(dir, "factory.db");
    const first = openDatabase(path);
    runMigrations(first, [eventLogMigration()]);
    const second = openDatabase(path);
    second.pragma("busy_timeout = 0");

    first.exec("BEGIN IMMEDIATE");
    appendEvent(first, ci());
    const whileHeld = (): unknown => appendEvent(second, ci({ source: "backstop" }));
    expect(whileHeld).toThrow(/locked|busy/i);
    first.exec("COMMIT");
    const afterCommit = appendEvent(second, ci({ source: "backstop" }));

    expect(afterCommit).toEqual({ inserted: false, seq: 1, by: "occurrence" });
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
