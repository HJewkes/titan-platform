import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { ratePeaks } from "../github-api/rate-sample.js";
import { agreement, kindCensus } from "./agreement.js";
import { appendEvent, eventLogMigration, type IdentityEvent } from "./event-log.js";
import { f11Report } from "./f11-report.js";
import { f11Window, readF11Window } from "./f11-window.js";

const SINCE = "2026-10-20T00:00:00Z";
const UNTIL = "2026-10-22T00:00:00Z";
const MINUTE = 60_000;
const at = (base: string, deltaMs: number): string => new Date(Date.parse(base) + deltaMs).toISOString();

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "f11-window-"));
  dbPath = join(dir, "factory.db");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function event(name: string, observedAt: string, source: IdentityEvent["source"] = "webhook"): IdentityEvent {
  return {
    rule: "identity",
    source,
    kind: "HeadPushed",
    repo: "acme/widget",
    subject: `acme/widget#${name}`,
    keys: { name },
    occurrenceKey: `v1|HeadPushed|${name}`,
    observedAt,
    payload: {},
  };
}

function seed(events: IdentityEvent[]): void {
  const db = openDatabase(dbPath);
  runMigrations(db, [eventLogMigration()]);
  for (const row of events) appendEvent(db, row);
  db.close();
}

describe("readF11Window", () => {
  it("returns the rows observed in [since, until), in seq order", () => {
    seed([event("before", at(SINCE, -1)), event("first", at(SINCE, 0)), event("last", at(UNTIL, -1)), event("after", at(UNTIL, 0))]);

    const rows = readF11Window(dbPath, f11Window(SINCE, UNTIL));

    expect(rows.map((row) => row.keys.name)).toEqual(["first", "last"]);
    expect(rows[0]).toMatchObject({ seq: 2, source: "webhook", kind: "HeadPushed", subject: "acme/widget#first", occurrenceKey: "v1|HeadPushed|first" });
  });

  it("opens the log read-only, so a missing database is an error and no file appears", () => {
    expect(() => readF11Window(dbPath, f11Window(SINCE, UNTIL))).toThrow();
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("f11Window", () => {
  it("normalises both ends so a bound without milliseconds still meets a stored row at that instant", () => {
    expect(f11Window(SINCE, UNTIL)).toEqual({ since: "2026-10-20T00:00:00.000Z", until: "2026-10-22T00:00:00.000Z" });
  });

  it("refuses an unparseable or empty window", () => {
    expect(() => f11Window("yesterday", UNTIL)).toThrow(/needs two dates/);
    expect(() => f11Window(SINCE, "tomorrow")).toThrow(/needs two dates/);
    expect(() => f11Window(UNTIL, UNTIL)).toThrow(/is empty/);
    expect(() => f11Window(UNTIL, SINCE)).toThrow(/is empty/);
  });
});

describe("F11 clock 2 over a stored window", () => {
  it("reports an unconfirmed webhook row as webhookOnly and one whose withinMs runs past until as pending", () => {
    const missed = at(SINCE, 60 * MINUTE);
    const late = at(UNTIL, -2 * MINUTE);
    seed([event("missed", missed), event("late", late)]);
    const window = f11Window(SINCE, UNTIL);

    const report = f11Report(
      { clock: "webhook", window, rows: readF11Window(dbPath, window), log: "", rate: [], withinMs: 6 * MINUTE },
      { kindCensus, agreement, ratePeaks },
    );

    expect(report.agreement).toMatchObject({ matched: [], webhookOnly: [1], pending: [2], backstopOnly: [], divergentKeys: [] });
  });
});
