import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

// Fixtures equal to agent-chat scripts/seat/testdata/scorecard (factory.sql, events.sql, logs/, tasks/), from test-scorecard.sh.
const UNTIL = "2026-10-04T12:00:00Z";

const FACTORY_SQL = `
create table workflow_run (id text primary key, workflow_name text, params text, status text, step_results text, started_at text, completed_at text);
create table shepherd_registration (run_id text, repo text, pr integer, task text, created_at text);
create table shepherd_freeze (repo text primary key, red_sha text, frozen_at text, episode integer, thawed_at text);
create table hitl_gate (id text primary key, status text, created_at text);
insert into workflow_run values
 ('r1','shepherd-pr','{"repo":"o/proj","pr":"1","task":"proj/T-1"}','completed','{"merge:0:0":{"completedAt":"2026-10-03T10:00:00.000Z","data":{"result":{"done":true,"mergeSha":"a"}}}}','2026-10-03T09:00:00.000Z','2026-10-03T10:01:00.000Z'),
 ('r2','shepherd-pr','{"repo":"o/proj","pr":"2","task":"proj/T-2"}','completed','{"approve-merge":{"data":{"decision":"merge"}},"merge:0:0":{"completedAt":"2026-10-03T11:00:00.000Z","data":{"result":{"done":true,"mergeSha":"b"}}}}','2026-10-03T09:30:00.000Z','2026-10-03T11:01:00.000Z'),
 ('r3','shepherd-pr','{"repo":"o/proj","pr":"3","task":"proj/T-1"}','completed','{"merge:0:0":{"completedAt":"2026-10-02T10:00:00.000Z","data":{"result":{"done":true,"mergeSha":"c"}}}}','2026-10-02T09:00:00.000Z','2026-10-02T10:01:00.000Z'),
 ('r4','shepherd-pr','{"repo":"o/proj","pr":"4","task":"proj/T-1"}','running','{}','2026-10-03T09:00:00.000Z',null);
insert into shepherd_registration values
 ('r1','o/proj',1,'proj/T-1','2026-10-03T09:30:00.000Z'),
 ('r2','o/proj',2,'proj/T-2','2026-10-03T10:00:00.000Z');
insert into shepherd_freeze values
 ('o/proj','x','2026-10-03T12:00:00.000Z',1,'2026-10-03T12:40:00.000Z'),
 ('o/other','y','2026-10-04T06:00:00.000Z',1,null);
insert into hitl_gate values
 ('r8/approve-merge','pending','2026-10-03T08:00:00.000Z'),
 ('r9/approve-merge','pending','2026-10-04T11:30:00.000Z'),
 ('r7/approve-merge','resolved','2026-10-03T07:00:00.000Z');`;

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

const SPEC = `since: 2026-10-03
rows:
  merges: { baseline: 40 in the 10-02 window, target: 20 per day }
  lead: { baseline: "median 14 min, p90 482 min" }
  register: { baseline: median 15.0 min }
  cfr: { baseline: Not measured }
  recovery: { baseline: Not measured }
  rework: { baseline: 35.2 percent }
  mechanical: { baseline: "6.9 percent (21 of 305 deduped FIX_FIRST, hand-checked 2026-09-29..10-04)" }
  breakglass: { baseline: 100 percent on 10-03 }
  queue: { baseline: "50 PRs, 516 hours since 09-13" }
  autonomy: { baseline: All of them }
  cost: { baseline: none }
`;

let scratch: string;

function writeFixtures(): { env: NodeJS.ProcessEnv; db: string; spec: string } {
  const db = join(scratch, "factory.db");
  const factory = openDatabase(db);
  factory.exec(FACTORY_SQL);
  factory.close();
  mkdirSync(join(scratch, "agent-chat"));
  const events = openDatabase(join(scratch, "agent-chat", "events.db"));
  events.exec("create table events (id integer primary key autoincrement, ts integer not null, kind text not null, actor text not null, target text, msg_id text, ref text, body text, meta text)");
  for (const [ts, body] of EVENTS) events.prepare("insert into events (ts, kind, actor, body) values (?, 'message', 'rv', ?)").run(ts, body);
  events.close();
  for (const [seat, records] of Object.entries(LOGS)) {
    mkdirSync(join(scratch, "autonomy", "logs", seat), { recursive: true });
    writeFileSync(join(scratch, "autonomy", "logs", seat, "dispatch.jsonl"), records.map((r) => JSON.stringify(r)).join("\n"));
  }
  mkdirSync(join(scratch, "tasks", "proj", "tasks"), { recursive: true });
  for (const id of ["T-1", "T-2"]) writeFileSync(join(scratch, "tasks", "proj", "tasks", `${id}.yml`), `id: ${id}\ncreated: 2026-10-03\n`);
  writeFileSync(join(scratch, "spec.yml"), SPEC);
  const env = { AGENT_CHAT_HOME: join(scratch, "agent-chat"), AUTONOMY_ROOT: join(scratch, "autonomy"), ACTIVE_ROOT: join(scratch, "tasks"), HOME: join(scratch, "no-home") };
  return { env, db, spec: join(scratch, "spec.yml") };
}

async function scorecard(env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["scorecard", "--until", UNTIL, ...args], { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env });
  return { code, out: out.join(""), err: err.join("") };
}

function lineOf(out: string, metric: string): string {
  return out.split("\n").find((line) => line.startsWith(`SCORECARD ${metric}:`)) ?? `(no ${metric} line)`;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "cli-scorecard-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("titan-factory scorecard", () => {
  it("prints every row as scripts/seat/scorecard does over the same fixtures", async () => {
    const { env, db, spec } = writeFixtures();

    const { code, out } = await scorecard(env, ["--db", db, "--spec", spec]);

    expect(code).toBe(0);
    expect(out.split("\n")[0]).toBe("SCORECARD since 2026-10-03");
    expect(lineOf(out, "Merges per day by Shepherd with no human step")).toContain("0.67 per day (1 with no human step of 2 merges in 1.5 days)");
    expect(lineOf(out, "Task ready to merged")).toContain("median 630 min, p90 654 min");
    expect(lineOf(out, "Register to merge")).toContain("median 45.0 min (n=2) | source Shepherd ledger | baseline median 15.0 min");
    expect(lineOf(out, "Change failure rate")).toContain("red main 50.0 percent (2 of 4); reverts 25.0 percent (1 of 4); post-merge audit defects not measured");
    expect(lineOf(out, "Time main stays red")).toContain("median 40 min over 1 episodes (1 still red)");
    expect(lineOf(out, "First-pass FIX_FIRST share")).toContain("50.0 percent (3 of 6)");
    expect(lineOf(out, "Mechanical first-blocker share")).toContain("n/a (no Class line yet; 3 unclassified of 3 FIX_FIRST rounds) | source events.db FIX_FIRST Class line | baseline 6.9 percent (21 of 305");
    expect(lineOf(out, "Share of merges by seat merge script")).toContain("50.0 percent (2 of 4)");
    expect(lineOf(out, "Approved and waiting over 60 minutes")).toContain("1 PRs over 60 min, oldest 28 hours");
    expect(lineOf(out, "Coordinator spawns for milestone tasks")).toContain("75.0 percent (3 of 4)");
    expect(lineOf(out, "Cost per merged PR")).toContain("$1.67 per merged task (median $1.50; $5.00 over 3 merged tasks) [usd_est on 3 of 3 merged tasks]");
  });

  it("appends a row's target from the spec after its baseline", async () => {
    const { env, db, spec } = writeFixtures();

    const { out } = await scorecard(env, ["--db", db, "--spec", spec]);

    expect(lineOf(out, "Merges per day by Shepherd with no human step")).toMatch(/\| baseline 40 in the 10-02 window \| target 20 per day$/);
  });

  it("prints eleven measured rows with --json, each carrying its baseline", async () => {
    const { env, db, spec } = writeFixtures();

    const { code, out } = await scorecard(env, ["--db", db, "--spec", spec, "--json"]);

    const report = JSON.parse(out) as { since: string; until: string; rows: { id: string; measured: boolean; baseline: string; coverage?: object }[] };
    expect(code).toBe(0);
    expect(report.since).toBe("2026-10-03");
    expect(report.until).toBe("2026-10-04T12:00:00.000Z");
    expect(report.rows.map((r) => r.id)).toEqual(["merges", "lead", "register", "cfr", "recovery", "rework", "mechanical", "breakglass", "queue", "autonomy", "cost"]);
    expect(report.rows.every((r) => r.measured)).toBe(true);
    expect(report.rows.find((r) => r.id === "cost")).toMatchObject({ baseline: "none", coverage: { tasksWithUsdEst: 3, mergedTasks: 3 } });
  });

  it("lets --since override the spec's window start", async () => {
    const { env, db, spec } = writeFixtures();

    const { out } = await scorecard(env, ["--db", db, "--spec", spec, "--since", "2026-10-05"]);

    expect(out.split("\n")[0]).toBe("SCORECARD since 2026-10-05");
    expect(lineOf(out, "Merges per day by Shepherd with no human step")).toContain(": not measured |");
  });

  it("prints not measured, never 0, for the factory rows of an empty factory DB", async () => {
    const { env, spec } = writeFixtures();
    const empty = join(scratch, "empty.db");
    openDatabase(empty).close();

    const { code, out } = await scorecard(env, ["--db", empty, "--spec", spec]);

    expect(code).toBe(0);
    for (const metric of ["Merges per day by Shepherd with no human step", "Task ready to merged", "Register to merge", "Time main stays red", "Approved and waiting over 60 minutes"]) {
      expect(lineOf(out, metric)).toContain(`${metric}: not measured |`);
    }
    expect(out).not.toMatch(/: 0[ .]/);
  });

  it("prints not measured on every row when no source exists", async () => {
    const { spec } = writeFixtures();
    const env = { AUTONOMY_ROOT: join(scratch, "none"), AGENT_CHAT_HOME: join(scratch, "none"), HOME: join(scratch, "none") };

    const { code, out } = await scorecard(env, ["--db", join(scratch, "missing.db"), "--spec", spec]);

    expect(code).toBe(0);
    expect(out.match(/: not measured/g)).toHaveLength(11);
  });

  it("exits 2 naming the spec when it is missing", async () => {
    const { env, db } = writeFixtures();

    const { code, out, err } = await scorecard(env, ["--db", db, "--spec", join(scratch, "absent.yml")]);

    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("cannot read the spec");
    expect(err).toContain("absent.yml");
  });

  it("exits 2 when no --spec is given", async () => {
    const { env, db } = writeFixtures();

    const { code, err } = await scorecard(env, ["--db", db]);

    expect(code).toBe(2);
    expect(err).toContain("--spec <file> is required");
  });

  it("exits 2 naming the row of a spec that lacks its baseline", async () => {
    const { env, db } = writeFixtures();
    writeFileSync(join(scratch, "bad.yml"), SPEC.replace(/^ {2}cost:.*\n/m, ""));

    const { code, err } = await scorecard(env, ["--db", db, "--spec", join(scratch, "bad.yml")]);

    expect(code).toBe(2);
    expect(err).toContain("invalid spec");
    expect(err).toContain("rows.cost");
  });

  it("exits 2 naming the variables when both roots are unset", async () => {
    const { db, spec } = writeFixtures();

    const { code, err } = await scorecard({ HOME: scratch }, ["--db", db, "--spec", spec]);

    expect(code).toBe(2);
    expect(err).toContain("AUTONOMY_ROOT and ACTIVE_ROOT unset");
  });

  it("reads the task created dates from ACTIVE_ROOT when AUTONOMY_ROOT is unset", async () => {
    const { db, spec } = writeFixtures();
    const env = { ACTIVE_ROOT: join(scratch, "tasks"), AGENT_CHAT_HOME: join(scratch, "agent-chat"), HOME: scratch };

    const { out } = await scorecard(env, ["--db", db, "--spec", spec]);

    expect(lineOf(out, "Task ready to merged")).toContain("median 630 min, p90 654 min");
  });
});
