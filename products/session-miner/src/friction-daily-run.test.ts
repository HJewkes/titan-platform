import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { depositItemId } from "@titan-design/owner-queue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { parseWindowMs, runFrictionDaily, type ConsoleInboxPort } from "./friction-daily-run.js";
import { seedEventsDb } from "./insights/fixture.js";

const NOW = new Date("2030-03-10T14:05:00.000Z");
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();

let dir: string;
let eventsDb: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "friction-daily-"));
  eventsDb = seedEventsDb(path.join(dir, "events.db"), [
    { ts: ago(5), kind: "agent_spawned", actor: "coord", target: "w1", body: "" },
    { ts: ago(3), actor: "w1", target: "coord", body: "Status: DONE\nFriction: classifier denied the push" },
    { ts: ago(2), actor: "w2", target: "coord", body: "Status: DONE\nConcerns: CI checks queued an hour" },
    { ts: ago(30), actor: "w3", target: "coord", body: "Status: DONE\nFriction: outside the window" },
  ]);
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

const run = (calls: string[], dryRun: boolean, archiveDir = path.join(dir, "archive")) =>
  runFrictionDaily({ eventsDb, archiveDir, now: NOW, windowMs: 24 * HOUR, dryRun, inbox: fakeInbox(calls) });

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

  it("archives one raw row per report in the window and a markdown summary", async () => {
    const result = await run([], false);

    const rows = readFileSync(path.join(dir, "archive", "2030-03-10.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((r) => [r.agent, r.agentHours, r.lines[0].source, r.lines[0].cluster])).toEqual([
      ["w1", 2, "friction", "denials"],
      ["w2", null, "concerns", "ci-wait"],
    ]);
    expect(readFileSync(path.join(dir, "archive", "2030-03-10.md"), "utf8")).toContain("1. denials: 1 of 2 reports, 2 agent-hours");
    expect(result.archived).toHaveLength(2);
  });

  it("writes and files nothing on a dry run", async () => {
    const calls: string[] = [];

    const result = await run(calls, true);

    expect(calls).toEqual([]);
    expect(existsSync(path.join(dir, "archive"))).toBe(false);
    expect(result).toMatchObject({ filed: null, archived: [], report: { reports: 2 } });
    expect(result.top).toHaveLength(2);
  });

  it("prints the top clusters from the CLI on a dry run and writes no archive", async () => {
    const recent = new Date(Date.now() - HOUR).toISOString();
    const liveDb = seedEventsDb(path.join(dir, "live.db"), [{ ts: recent, actor: "w1", target: "coord", body: "Status: DONE\nFriction: CI was slow" }]);
    const out: string[] = [];
    const calls: string[] = [];

    const code = await runCli(["friction-daily", "--dry-run", "--archive-dir", path.join(dir, "archive")], {
      stdout: (t) => out.push(t),
      stderr: () => {},
      env: { TITAN_MINER_STATE: dir, TITAN_MINER_EVENTS_DB: liveDb },
      consoleInbox: fakeInbox(calls),
    });

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(out.join("")).toContain("1 reports, 1 with Friction:, 0 fallback only");
    expect(out.join("")).toContain("1. ci-wait: 1 of 1 reports");
    expect(out.join("")).toContain("dry run: nothing written or filed");
    expect(existsSync(path.join(dir, "archive"))).toBe(false);
  });

  it("refuses a --since it cannot read", () => {
    expect([parseWindowMs("24h"), parseWindowMs("2d"), parseWindowMs("0h"), parseWindowMs("1w")]).toEqual([24 * HOUR, 48 * HOUR, null, null]);
  });
});
