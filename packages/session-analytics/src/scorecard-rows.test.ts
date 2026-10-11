import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENTS_TABLE_DDL } from "./events-db.js";
import { readDispatchJournal, scorecardJournalRows, scorecardRowText, type DispatchRecord, type ScorecardRow } from "./scorecard-rows.js";

// Fixtures equal to agent-chat scripts/seat/testdata/scorecard (events.sql, logs/, logs-lowcov/), from test-scorecard.sh.
const SINCE = "2026-10-03";
const NOW = "2026-10-04T12:00:00Z";

const EVENTS: readonly [number, string][] = [
  [1790000000000, "Verdict: FIX_FIRST\nPR: o/old#9\nHead: 0"],
  [1791050000000, "Verdict: FIX_FIRST\nPR: o/proj#1\nHead: a"],
  [1791051000000, "Verdict: MERGE\nPR: o/proj#1\nHead: a2"],
  [1791052000000, "Verdict: MERGE\nPR: o/proj#2\nHead: b"],
  [1791053000000, "Verdict: MERGE\nPR: o/proj#7\nHead: c"],
  [1791054000000, "Verdict: FIX_FIRST\nPR: o/proj#8\nHead: d"],
  [1791055000000, "not a verdict"],
  [1791056000000, "Verdict: WAIT\nPR: o/proj#3\nHead: e"],
  [1791057000000, "Verdict: MERGE\nPR: o/proj#3\nHead: e"],
  [1791058000000, "Verdict: WAIT\nPR: o/proj#4\nHead: f"],
  [1791059000000, "Verdict: FIX_FIRST\nPR: o/proj#4\nHead: f"],
  [1791060000000, "Verdict: WAIT\nPR: o/proj#5\nHead: g"],
];

const LOGS: Record<string, readonly object[]> = {
  loose: [
    { ts: "2026-10-03T09:00:00Z", task: "X-1", outcome: "dispatched", milestone: "M1" },
    { ts: "2026-10-03T09:55:00Z", task: "T-1", outcome: "retired", usd_est: 0.5 },
  ],
  "seat-coord": [
    { ts: "2026-10-03T10:05:00Z", task: "T-1", pr: "o/proj#1", outcome: "merged", usd_est: 99.0 },
    { ts: "2026-10-03T13:00:00-0600", task: "T-7", pr: "o/proj#7", outcome: "merged", usd_est: 99.0 },
    { ts: "2026-10-03T14:00:00-06:00", task: "T-8", pr: "o/proj#8", outcome: "merged", usd_est: 99.0, note: "Revert of #7" },
    { ts: "2026-10-03T08:00:00Z", task: "T-1", outcome: "dispatched", milestone: "M1" },
    { ts: "2026-10-03T08:10:00Z", task: "T-2", outcome: "dispatched", note: "milestone:M1 slice" },
    { ts: "2026-10-03T08:20:00Z", task: "T-3", outcome: "dispatched", milestone: "M2" },
    { ts: "2026-10-03T08:30:00Z", task: "T-4", outcome: "dispatched" },
    { ts: "2026-10-01T08:30:00Z", task: "T-5", outcome: "dispatched", milestone: "M1" },
    { ts: "2026-10-03T09:50:00Z", task: "T-1", outcome: "retired", usd_est: 1.0 },
    { ts: "2026-10-01T09:50:00Z", task: "T-7", outcome: "retired", usd_est: 3.0 },
    { ts: "2026-10-03T14:10:00Z", task: "T-8", outcome: "retired", usd_est: 0.5 },
    { ts: "2026-10-03T14:20:00Z", task: "T-9", outcome: "retired", usd_est: 50.0 },
  ],
};

const LOGS_LOWCOV: Record<string, readonly object[]> = {
  "seat-coord": [
    { ts: "2026-10-03T10:05:00Z", task: "T-1", pr: "o/proj#1", outcome: "merged", usd_est: 99.0 },
    { ts: "2026-10-03T10:06:00Z", task: "T-7", pr: "o/proj#7", outcome: "merged", usd_est: 99.0 },
    { ts: "2026-10-03T10:07:00Z", task: "T-8", pr: "o/proj#8", outcome: "merged" },
    { ts: "2026-10-03T10:09:00Z", task: "T-1", outcome: "retired", usd_est: 1.0 },
  ],
};

let scratch: string;
let eventsDb: Db;

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "titan-scorecard-"));
  eventsDb = eventsWith(EVENTS.map(([ts, body]) => ({ ts, actor: "rv", body })));
});
afterEach(() => {
  eventsDb.close();
  rmSync(scratch, { recursive: true, force: true });
});

function eventsWith(rows: readonly { ts: number; actor: string; body: string }[]): Db {
  const db = openDatabase(":memory:");
  db.exec(EVENTS_TABLE_DDL);
  const insert = db.prepare("INSERT INTO events (ts, kind, actor, body) VALUES (?, 'message', ?, ?)");
  for (const r of rows) insert.run(r.ts, r.actor, r.body);
  return db;
}

function writeLogs(name: string, logs: Record<string, readonly object[]>, extraLines = ""): string {
  const dir = path.join(scratch, name);
  for (const [seat, records] of Object.entries(logs)) {
    mkdirSync(path.join(dir, seat), { recursive: true });
    writeFileSync(path.join(dir, seat, "dispatch.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n" + extraLines);
  }
  return dir;
}

function rows(input: { eventsDb?: Db | null; dispatchRecords?: readonly DispatchRecord[]; since?: string }): Map<string, ScorecardRow> {
  const all = scorecardJournalRows({ eventsDb: null, dispatchRecords: [], since: SINCE, now: NOW, ...input });
  return new Map(all.map((r) => [r.id, r]));
}

const text = (r: ScorecardRow | undefined) => (r ? scorecardRowText(r) : "missing row");

describe("scorecard rows over the scorecard fixtures", () => {
  it("count the first non-WAIT verdict per PR in the window for first-pass FIX_FIRST", () => {
    expect(text(rows({ eventsDb }).get("rework"))).toBe("50.0 percent (3 of 6)");
  });

  it("report the mechanical share as n/a while no FIX_FIRST carries a Class line", () => {
    expect(text(rows({ eventsDb }).get("mechanical"))).toBe("n/a (no Class line yet; 3 unclassified of 3 FIX_FIRST rounds)");
  });

  it("count coordinator spawns among milestone dispatches in the window", () => {
    const dispatchRecords = readDispatchJournal(writeLogs("logs", LOGS));
    expect(text(rows({ dispatchRecords }).get("autonomy"))).toBe("75.0 percent (3 of 4) dispatched by a coordinator seat");
  });

  it("sum retired usd_est per merged task across seats and earlier windows", () => {
    const dispatchRecords = readDispatchJournal(writeLogs("logs", LOGS));
    expect(text(rows({ dispatchRecords }).get("cost"))).toBe(
      "$1.67 per merged task (median $1.50; $5.00 over 3 merged tasks) [usd_est on 3 of 3 merged tasks]",
    );
  });

  it("mark every row measured when every source has data", () => {
    const all = rows({ eventsDb, dispatchRecords: readDispatchJournal(writeLogs("logs", LOGS)) });
    expect([...all.values()].map((r) => [r.id, r.measured])).toEqual([
      ["rework", true],
      ["mechanical", true],
      ["autonomy", true],
      ["cost", true],
    ]);
  });
});

describe("the mechanical first-blocker row with Class lines", () => {
  it("counts a repeat at the same reviewer, PR and head once and reports unclassified rounds", () => {
    const fixFirst = (actor: string, pr: number, head: string, cls?: string) => ({
      ts: 1791050000000,
      actor,
      body: `Verdict: FIX_FIRST\nPR: o/proj#${pr}\nHead: ${head}${cls ? `\nClass: ${cls}` : ""}`,
    });
    const db = eventsWith([
      fixFirst("rv", 10, "e", "rebase"),
      fixFirst("rv", 10, "e", "rebase"),
      fixFirst("rv2", 10, "e", "lint"),
      fixFirst("rv", 11, "f", "defect"),
      fixFirst("rv", 12, "g", "test"),
      fixFirst("rv", 13, "h"),
      fixFirst("rv", 14, "i", "ci-red"),
    ]);
    expect(text(rows({ eventsDb: db }).get("mechanical"))).toBe("60.0 percent (3 of 5) of classified; 1 unclassified of 6 FIX_FIRST rounds");
    db.close();
  });
});

describe("the cost row below the usd_est coverage floor", () => {
  it("is not measured and still names its coverage", () => {
    const cost = rows({ dispatchRecords: readDispatchJournal(writeLogs("logs-lowcov", LOGS_LOWCOV)) }).get("cost");
    expect(cost).toMatchObject({ value: null, measured: false, coverage: { tasksWithUsdEst: 1, mergedTasks: 3 } });
    expect(text(cost)).toBe("not measured (usd_est on 1 of 3 merged tasks)");
  });
});

describe("absent or empty sources", () => {
  it("print not measured on every row, never zero", () => {
    const all = [...rows({ eventsDb: null, dispatchRecords: readDispatchJournal(path.join(scratch, "none")) }).values()];
    expect(all.map(text)).toEqual(["not measured", "not measured", "not measured", "not measured (usd_est on 0 of 0 merged tasks)"]);
    expect(all.every((r) => !r.measured)).toBe(true);
  });

  it("read an events.db with no events table as empty", () => {
    const bare = openDatabase(":memory:");
    expect(rows({ eventsDb: bare }).get("rework")?.value).toBeNull();
    bare.close();
  });

  it("read a window after every record as empty", () => {
    const all = rows({ eventsDb, dispatchRecords: readDispatchJournal(writeLogs("logs", LOGS)), since: "2026-10-05" });
    expect([...all.values()].filter((r) => r.measured)).toEqual([]);
  });
});

describe("readDispatchJournal", () => {
  it("takes the seat from the directory, reads offsets with or without a colon and skips unparseable lines; a wrong-typed field reads as absent", () => {
    const records = readDispatchJournal(writeLogs("logs", { "x-coord": LOGS["seat-coord"]!.slice(1, 3) }, "not json\n{\"task\":\"no-ts\"}\n{\"ts\":\"2026-10-03T21:00:00\",\"task\":5}\n"));
    expect(records.map((r) => [r.seat, r.task, new Date(r.at).toISOString()])).toEqual([
      ["x-coord", "T-7", "2026-10-03T19:00:00.000Z"],
      ["x-coord", "T-8", "2026-10-03T20:00:00.000Z"],
      ["x-coord", undefined, "2026-10-03T21:00:00.000Z"],
    ]);
  });
});
