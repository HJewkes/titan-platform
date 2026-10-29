import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT } from "@titan-design/registry";
import { EVENTS_TABLE_DDL } from "@titan-design/session-analytics";
import { openDatabase } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { runReportIntake } from "./report-intake-run.js";

const NOW = new Date("2030-03-10T14:00:00.000Z");
const HOUR = 3_600_000;
const ago = (hours: number) => NOW.getTime() - hours * HOUR;
const DONE = "Status: DONE\nPR: o/r#1\nHead: 0123456789abcdef\nConcerns: none";

type Event = [ts: number, kind: string, actor: string, target: string, body?: string];

function seed(file: string, events: readonly Event[]): string {
  const db = openDatabase(file);
  db.exec(EVENTS_TABLE_DDL);
  const insert = db.prepare("INSERT INTO events (ts, kind, actor, target, body) VALUES (?, ?, ?, ?, ?)");
  for (const [ts, kind, actor, target, body] of events) insert.run(ts, kind, actor, target, body ?? null);
  db.close();
  return file;
}

/** w1 is retired, w2 gets a coordinator message, w3 a resume logged under another CLI caller, w4 nothing, w5 an unreadable report. */
const DAY: Event[] = [
  [ago(10), "message", "w1", "coord", DONE],
  [ago(9), "agent_retired", "coord", "w1"],
  [ago(10), "message", "w2", "coord", DONE],
  [ago(9), "message", "coord", "w2", "one more thing: rename the flag"],
  [ago(10), "message", "w3", "coord", DONE],
  [ago(9), "agent_resumed", "human", "w3"],
  [ago(10), "message", "w4", "coord", DONE],
  [ago(10), "message", "w5", "coord", "Status: SHIPPED IT"],
];

describe("report intake, shadow", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "report-intake-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("counts the parse rate and scores closeout against what happened next", () => {
    const eventsDb = seed(path.join(dir, "events.db"), DAY);

    const result = runReportIntake({ eventsDb, now: NOW, windowMs: 24 * HOUR, evaluate: true, out: null });

    expect({ reports: result.reports, parsed: result.parsed }).toEqual({ reports: 5, parsed: 4 });
    expect(result.eval?.plainDone).toEqual({ reports: 4, strict: 2, attributed: 3, gold: { retired: 1, resumed: 1, messaged: 1, left: 1 } });
  });

  it("stops the gold at the agent's next report, so a later round's message is not this report's", () => {
    const eventsDb = seed(path.join(dir, "events.db"), [
      [ago(10), "message", "w1", "coord", DONE],
      [ago(9), "message", "w1", "coord", DONE],
      [ago(8), "message", "coord", "w1", "please fix the test"],
    ]);

    const result = runReportIntake({ eventsDb, now: NOW, windowMs: 24 * HOUR, evaluate: true, out: null });

    expect(result.eval?.plainDone.gold).toEqual({ retired: 0, resumed: 0, messaged: 1, left: 1 });
  });

  it("refuses to run without --shadow and writes rows with it", async () => {
    const eventsDb = seed(path.join(dir, "events.db"), [[Date.now() - HOUR, "message", "w1", "coord", DONE]]);
    const out = path.join(dir, "rows.jsonl");
    const io = { stdout: (t: string) => stdout.push(t), stderr: (t: string) => stderr.push(t), env: { TITAN_MINER_EVENTS_DB: eventsDb, TITAN_MINER_STATE: dir } };
    const stdout: string[] = [];
    const stderr: string[] = [];

    expect(await runCli(["report", "intake", "--since", "1d"], io)).toBe(EXIT.USAGE);
    expect(stderr.join("")).toContain("only --shadow");
    expect(await runCli(["report", "intake", "--since", "1d", "--shadow", "--out", out], io)).toBe(0);
    expect(readFileSync(out, "utf8").trim().split("\n").map((line): unknown => JSON.parse(line))).toEqual([
      expect.objectContaining({ agent: "w1", status: "DONE" }),
    ]);
  });
});
