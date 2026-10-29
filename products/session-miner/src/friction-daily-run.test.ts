import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { depositItemId } from "@titan-design/owner-queue";
import { EVENTS_TABLE_DDL } from "@titan-design/session-analytics";
import { openDatabase } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runCli } from "./cli.js";
import { parseWindowMs, runFrictionDaily, type ConsoleInboxPort } from "./friction-daily-run.js";

const archiveRow = z.object({ type: z.string(), agent: z.string(), agreement: z.object({ agreement: z.string() }).nullable().optional() });
const NOW = new Date("2030-03-10T14:05:00.000Z");
const HOUR = 3_600_000;
const ago = (hours: number, from = NOW) => new Date(from.getTime() - hours * HOUR).toISOString();

interface Event {
  ts: string;
  kind: string;
  actor: string;
  target: string;
  body?: string;
  meta?: object;
}

function seedEvents(file: string, events: readonly Event[]): string {
  const db = openDatabase(file);
  db.exec(EVENTS_TABLE_DDL);
  const insert = db.prepare("INSERT INTO events (ts, kind, actor, target, body, meta) VALUES (?, ?, ?, ?, ?, ?)");
  for (const e of events) insert.run(Date.parse(e.ts), e.kind, e.actor, e.target, e.body ?? null, e.meta ? JSON.stringify(e.meta) : null);
  db.close();
  return file;
}

/** A transcript under `<profiles>/<profile>/projects/<project>/<session>.jsonl` holding one denied call. */
function writeTranscript(profiles: string, sessionId: string, deniedAt: string, nextAt: string): void {
  const dir = path.join(profiles, "p1", "projects", "proj");
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "assistant", timestamp: deniedAt, message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "gh pr merge 1" } }] } },
    { type: "user", timestamp: deniedAt, message: { content: [{ type: "tool_result", tool_use_id: "c1", is_error: true, content: "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Merge]" }] } },
    { type: "assistant", timestamp: nextAt, message: { content: [{ type: "tool_use", id: "c2", name: "Bash", input: { command: "git status" } }] } },
  ];
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(file, new Date(nextAt), new Date(nextAt));
}

/** w1 reports a CI wait, but its log shows a denial; w2 reports through Concerns: only. */
function seedDay(dir: string, now: Date): { eventsDb: string; profiles: string } {
  const profiles = path.join(dir, "profiles");
  writeTranscript(profiles, "s-w1", ago(3, now), ago(3 - 4 / 60, now));
  const eventsDb = seedEvents(path.join(dir, `events-${now.getTime()}.db`), [
    { ts: ago(5, now), kind: "agent_spawned", actor: "coord", target: "w1", meta: { session_id: "s-w1", profile: "implementer" } },
    { ts: ago(2, now), kind: "message", actor: "w1", target: "coord", body: "Status: DONE\nFriction: waited an hour on CI checks" },
    { ts: ago(1, now), kind: "message", actor: "w2", target: "coord", body: "Status: DONE\nConcerns: the broker socket dropped twice" },
    { ts: ago(30, now), kind: "message", actor: "w3", target: "coord", body: "Status: DONE\nFriction: outside the window" },
  ]);
  return { eventsDb, profiles };
}

let dir: string;
let day: { eventsDb: string; profiles: string };
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "friction-daily-"));
  day = seedDay(dir, NOW);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Records every call in order; the item from two days back is the only earlier one still open. */
function fakeInbox(calls: string[]): ConsoleInboxPort {
  const open = depositItemId("friction-audit", "friction-daily-2030-03-08");
  return {
    withdraw: async (id, reason) => {
      calls.push(`withdraw ${id} ${reason}`);
      return id === open;
    },
    file: async (deposit) => {
      calls.push(`file ${deposit.depositId}`);
      return depositItemId(deposit.asker, deposit.depositId);
    },
  };
}

const run = (calls: string[], dryRun: boolean) =>
  runFrictionDaily({ ...day, profilesRoot: day.profiles, archiveDir: path.join(dir, "archive"), now: NOW, windowMs: 24 * HOUR, dryRun, inbox: fakeInbox(calls) });

describe("friction-daily", () => {
  it("withdraws the earlier days' items, superseded by today's id, before filing today's", async () => {
    const calls: string[] = [];

    const result = await run(calls, false);

    const today = depositItemId("friction-audit", "friction-daily-2030-03-10");
    expect(calls.slice(0, -1)).toHaveLength(7);
    expect(calls.slice(0, -1).every((c) => c.startsWith("withdraw ") && c.endsWith(` superseded:${today}`))).toBe(true);
    expect(calls.at(-1)).toBe("file friction-daily-2030-03-10");
    expect(result).toMatchObject({ filed: today, withdrawn: [depositItemId("friction-audit", "friction-daily-2030-03-08")] });
  });

  it("ranks the log side first and scores the report against it", async () => {
    const result = await run([], true);

    expect(result.logs).toMatchObject({ agents: 1, sessions: 1, clusters: [{ cluster: "denials", agents: 1, signals: 1, agentHours: 0.07 }] });
    expect(result.reports.clusters.map((c) => [c.cluster, c.reports])).toEqual([["ci-wait", 1], ["broker-infra", 1]]);
    expect(result.agreement).toMatchObject({ yes: 0, partial: 0, no: 1, logOnly: [{ cluster: "denials", agents: 1 }], reportOnly: [{ cluster: "ci-wait", agents: 1 }] });
    expect(result.summary.indexOf("Log-derived top 5")).toBeLessThan(result.summary.indexOf("Report-based top 5"));
  });

  it("archives one row per report and one per agent log, with its agreement", async () => {
    await run([], false);

    const rows = readFileSync(path.join(dir, "archive", "2030-03-10.jsonl"), "utf8").trim().split("\n").map((l) => archiveRow.parse(JSON.parse(l)));
    expect(rows.map((r) => [r.type, r.agent])).toEqual([["report", "w1"], ["report", "w2"], ["log", "w1"]]);
    expect(rows[2]!.agreement?.agreement).toBe("no");
    expect(readFileSync(path.join(dir, "archive", "2030-03-10.md"), "utf8")).toContain("self-report agreement 0/1");
  });

  it("writes and files nothing on a dry run", async () => {
    const calls: string[] = [];

    const result = await run(calls, true);

    expect(calls).toEqual([]);
    expect(existsSync(path.join(dir, "archive"))).toBe(false);
    expect(result).toMatchObject({ filed: null, archived: [], reports: { reports: 2 } });
  });

  it("prints both sides from the CLI on a dry run and writes no archive", async () => {
    const live = seedDay(path.join(dir, "live"), new Date());
    const out: string[] = [];
    const calls: string[] = [];

    const code = await runCli(["friction-daily", "--dry-run", "--archive-dir", path.join(dir, "archive"), "--profiles", live.profiles], {
      stdout: (t) => out.push(t),
      stderr: () => {},
      env: { TITAN_MINER_STATE: dir, TITAN_MINER_EVENTS_DB: live.eventsDb },
      consoleInbox: fakeInbox(calls),
    });

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(out.join("")).toContain("1. denials: 0.07 agent-hours over 1 of 1 agents");
    expect(out.join("")).toContain("self-report agreement 0/1");
    expect(out.join("")).toContain("dry run: nothing written or filed");
    expect(existsSync(path.join(dir, "archive"))).toBe(false);
  });

  it("refuses a --since it cannot read", () => {
    expect([parseWindowMs("24h"), parseWindowMs("2d"), parseWindowMs("0h"), parseWindowMs("1w")]).toEqual([24 * HOUR, 48 * HOUR, null, null]);
  });
});
