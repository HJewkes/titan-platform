import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import { createMinerContext, type MinerContext } from "./context.js";
import { EXIT_LOCKED } from "./graph-refresh.js";
import { seedBashCall, seedEventsDb, seedInsightGraph, type FixtureBashCall } from "./insights/fixture.js";
import { patternId } from "./insights/post-filter.js";
import type { BashCall } from "./insights/tool-gaps-sources.js";
import { runToolGapWeekly, snapshotPath, weekSnapshotSchema, type ActiveWorkPort, type ToolGapWeeklyOptions } from "./tool-gap-weekly-run.js";
import type { OpenTask } from "./tool-gap-weekly.js";

const CALLS: FixtureBashCall[] = [
  { toolUseId: "tu-1", sessionId: "impl-1", ts: "2026-09-10T01:00:00Z", outputChars: 400, command: "agent-chat agent ls | grep -E running" },
  { toolUseId: "tu-2", sessionId: "rev-1", ts: "2026-09-10T01:10:00Z", outputChars: 100, command: "agent-chat agent ls | grep -E done" },
  { toolUseId: "tu-3", sessionId: "seat-1", ts: "2026-09-10T01:20:00Z", outputChars: 50, command: "gh pr view 3 --json body | jq -r .body" },
];
const GREP = patternId("| grep -E");
const NOW = new Date("2026-09-12T00:00:00Z");

let dir: string;
let ctx: MinerContext;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-tool-gap-weekly-"));
  const config = resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, { TITAN_MINER_EVENTS_DB: seedEventsDb(path.join(dir, "events.db"), []) });
  ctx = createMinerContext(config);
  seedInsightGraph(ctx.graph().db);
  for (const call of CALLS) seedBashCall(ctx.graph().db, call);
});
afterAll(() => {
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Fakes {
  tasks: OpenTask[];
  added: string[];
  noted: string[];
  digests: string[];
}

function fakeActiveWork(fakes: Fakes, failAdd = false): ActiveWorkPort {
  return {
    openTasks: async (_initiative, tag) => fakes.tasks.filter((t) => t.tags.includes(tag)),
    async add(_initiative, action) {
      if (failAdd) throw new Error("active-work task add exited 1");
      fakes.added.push(action.patternId);
      fakes.tasks.push({ id: `TP-${fakes.tasks.length + 1}`, tags: action.tags });
    },
    note: async (_initiative, action) => void fakes.noted.push(action.taskId),
  };
}

function options(runDir: string, fakes: Fakes, failAdd = false): ToolGapWeeklyOptions {
  const commands = new Map(CALLS.map((c) => [c.toolUseId, c.command]));
  return {
    db: ctx.graph().db,
    dir: runDir,
    initiative: "demo",
    threshold: { minCalls: 2, minSessions: 2 },
    registry: [],
    reports: { command: async (call: BashCall) => commands.get(call.toolUseId) ?? null, help: async () => null, now: () => NOW },
    activeWork: fakeActiveWork(fakes, failAdd),
    notify: async (digest) => void fakes.digests.push(digest),
    log: () => {},
  };
}

const LAST_WEEK = `${JSON.stringify({
  gaps: { window: { since: null, until: null }, totals: { bashCalls: 0, skippedByHeads: 0, unreadable: 0, pipelines: 0, patterns: 0, sessions: 0 }, patterns: [] },
  adoption: { window: { since: "2026-09-01", until: "2026-09-05" }, totals: { bashCalls: 0, skippedByHeads: 0, unreadable: 0, opportunities: 0 }, opportunities: [] },
})}\n`;

const freshFakes = (): Fakes => ({ tasks: [], added: [], noted: [], digests: [] });

describe("tool-gap-weekly runner", () => {
  it("files a pattern's task once, notes it on a rerun the same week, and notifies once per run", async () => {
    const fakes = freshFakes();
    const runDir = path.join(dir, "rerun");

    const first = await runToolGapWeekly(options(runDir, fakes));
    const second = await runToolGapWeekly(options(runDir, fakes));

    expect(first).toMatchObject({ outcome: "ok", exitCode: 0, actions: [{ kind: "add", patternId: GREP }] });
    expect(second).toMatchObject({ outcome: "ok", actions: [{ kind: "note", patternId: GREP }] });
    expect(fakes.added).toEqual([GREP]);
    expect(fakes.noted).toEqual(["TP-1"]);
    expect(fakes.digests).toHaveLength(2);
    expect(fakes.digests[0]).toContain("agent-chat agent ls | grep -E");
  });

  it("keeps last week's snapshot and exits non-zero when a task add fails", async () => {
    const fakes = freshFakes();
    const runDir = path.join(dir, "failed-add");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(snapshotPath(runDir), LAST_WEEK);

    const result = await runToolGapWeekly(options(runDir, fakes, true));

    expect(result).toMatchObject({ outcome: "failed", error: "active-work task add exited 1" });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(snapshotPath(runDir), "utf8")).toBe(LAST_WEEK);
    expect(fakes.digests).toEqual([]);
  });

  it("writes this week's snapshot after the digest is sent", async () => {
    const runDir = path.join(dir, "snapshot");

    await runToolGapWeekly(options(runDir, freshFakes()));

    const snapshot = weekSnapshotSchema.parse(JSON.parse(readFileSync(snapshotPath(runDir), "utf8")));
    expect(snapshot.gaps.window.until).toBe(NOW.toISOString());
  });

  it("exits 75 and does nothing while another live run holds the lock", async () => {
    const fakes = freshFakes();
    const runDir = path.join(dir, "locked");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "run.lock"), JSON.stringify({ pid: process.pid, startedAt: NOW.toISOString() }));

    const result = await runToolGapWeekly(options(runDir, fakes));

    expect(result).toEqual({ outcome: "locked", exitCode: EXIT_LOCKED });
    expect(fakes.digests).toEqual([]);
  });
});
