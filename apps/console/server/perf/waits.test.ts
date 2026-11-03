import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRegistry, inProcessCaller } from "@titan-design/registry";
import { perfWaitsArgs, perfWaitsCli } from "../cli-perf.js";
import type { ConsoleContext } from "../owner-guard.js";
import { makeLogDir, removeDir } from "../perf-recorder.test-helpers.js";
import { perfCommands } from "./commands.js";
import { createPerfRecorder, type WaitLogRow } from "./recorder.js";
import { NO_COMMAND, rankWaits } from "./waits.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const REGISTERED = ["work.tasks", "inbox.list", "inbox.act"];

const wait = (commands: string[], ms: number, extra: Partial<WaitLogRow> = {}): WaitLogRow => ({ t: NOW, kind: "wait", view: "inbox", commands, ms, phase: "cold", mutation: false, ...extra });

let logDir: string;
beforeEach(() => {
  logDir = makeLogDir();
});
afterEach(() => removeDir(logDir));

describe("ranking waits", () => {
  it("puts the command that cost the owner the most total time first, whatever its single slowest wait", () => {
    const rows = [wait(["work.tasks"], 900), ...Array.from({ length: 10 }, () => wait(["inbox.list"], 150))];

    const ranked = rankWaits(rows);

    expect(ranked.map((stats) => [stats.command, stats.ownerMs])).toEqual([
      ["inbox.list", 1500],
      ["work.tasks", 900],
    ]);
  });

  it("gives p50, p95 and the waits past the command's budget", () => {
    const times = [100, 200, 300, 400, 500, 600, 700, 800, 900, 10_000];
    const rows = times.map((ms) => wait(["work.tasks"], ms));

    const [stats] = rankWaits(rows);

    expect(stats).toMatchObject({ waits: 10, p50: 500, p95: 10_000, max: 10_000, budgetMs: 9700, overBudget: 1 });
  });

  it("charges a wait to each command it was on, and one on none to the no-command bucket", () => {
    const rows = [wait(["inbox.list", "work.tasks"], 300, { mutation: true, phase: "refetch" }), wait([], 50)];

    const ranked = rankWaits(rows);

    expect(ranked.map((stats) => [stats.command, stats.ownerMs, stats.mutation, stats.cold])).toEqual([
      ["inbox.list", 300, 1, 0],
      ["work.tasks", 300, 1, 0],
      [NO_COMMAND, 50, 0, 1],
    ]);
  });
});

describe("perf.report with waits", () => {
  async function report(rows: unknown[]) {
    const recorder = createPerfRecorder({ dir: logDir, now: () => NOW });
    const registry = createRegistry<ConsoleContext>();
    const commands = perfCommands(recorder, () => REGISTERED);
    registry.register(commands["perf.report"]);
    registry.register(commands["perf.waits"]);
    const call = inProcessCaller(registry, (): ConsoleContext => ({ warnings: [], format: "json", surface: "http", auth: null, ownerWrites: false }));
    const answer = await call("perf.report", { rows });
    const waits = await call("perf.waits", { window: "15m" });
    await recorder.close();
    return { answer, waits };
  }

  it("keeps a wait and an action row and ranks the wait", async () => {
    const { answer, waits } = await report([
      { kind: "wait", view: "inbox", commands: ["inbox.act"], ms: 640, phase: "cold", mutation: true },
      { kind: "action", command: "inbox.act", ms: 610, ok: true },
    ]);

    expect(answer).toMatchObject({ ok: true, data: { accepted: 2 } });
    expect(waits).toMatchObject({ ok: true, data: { window: "15m", waits: [{ command: "inbox.act", waits: 1, ownerMs: 640, mutation: 1 }] } });
  });

  it("refuses a wait that names an unknown command or carries an id", async () => {
    const unknown = await report([{ kind: "wait", view: "inbox", commands: ["not.a.command"], ms: 1, phase: "cold", mutation: false }]);
    const withId = await report([{ kind: "wait", view: "inbox", commands: [], ms: 1, phase: "cold", mutation: false, id: "TP-1" }]);

    expect(unknown.answer.ok).toBe(false);
    expect(withId.answer.ok).toBe(false);
  });
});

describe("titan-console perf waits", () => {
  it("reads flags in any order and refuses a bad count, window or repeat", () => {
    expect(perfWaitsArgs(["perf", "waits"])).toEqual({ top: 10, window: "24h", json: false });
    expect(perfWaitsArgs(["perf", "waits", "--window", "7d", "--top", "3", "--json"])).toEqual({ top: 3, window: "7d", json: true });
    expect(perfWaitsArgs(["perf", "waits", "--top", "0"])).toBeNull();
    expect(perfWaitsArgs(["perf", "waits", "--window", "30d"])).toBeNull();
    expect(perfWaitsArgs(["perf", "waits", "--json", "--json"])).toBeNull();
  });

  it("prints the top N from the day files, most owner time first", async () => {
    const recorder = createPerfRecorder({ dir: `${logDir}/perf`, now: () => NOW });
    recorder.recordClient([
      { kind: "wait", view: "tasks", commands: ["work.tasks"], ms: 12_000, phase: "cold", mutation: false },
      { kind: "wait", view: "inbox", commands: ["inbox.list"], ms: 2000, phase: "refetch", mutation: false },
      { kind: "wait", view: "inbox", commands: ["inbox.act"], ms: 100, phase: "cold", mutation: true },
    ]);
    await recorder.close();

    const text = await perfWaitsCli({ stateDir: logDir }, { top: 2, window: "24h", json: false }, NOW + 1000);

    expect(text.split("\n")).toEqual([
      "owner waits, last 24h, most owner time first:",
      "1. work.tasks: 12.0 s over 1 waits, p50 12000 ms, p95 12000 ms, 1 cold, 0 on a write, 1 over the 9700 ms budget",
      "2. inbox.list: 2.0 s over 1 waits, p50 2000 ms, p95 2000 ms, 0 cold, 0 on a write",
    ]);
  });

  it("says so when no wait was recorded", async () => {
    expect(await perfWaitsCli({ stateDir: logDir }, { top: 5, window: "15m", json: false }, NOW)).toBe("no waits recorded in the last 15m");
  });
});
