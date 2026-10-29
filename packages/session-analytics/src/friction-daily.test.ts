import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENTS_TABLE_DDL, readSpawnerMessages, readWorkerReports, readWorkerSessions, type WorkerReportRecord } from "./events-db.js";
import type { AgentLog } from "./friction-agreement.js";
import { frictionDailyReport } from "./friction-daily.js";
import { clusterOf, extractFriction, lineCluster, normaliseFriction } from "./friction-lines.js";
import { frictionDeposit, renderFrictionMarkdown } from "./friction-render.js";
import type { LogSignal } from "./transcript-friction.js";

const WINDOW = { since: "2030-01-01T00:00:00.000Z", until: "2030-01-02T00:00:00.000Z" };

const report = (eventId: number, agent: string, body: string, hours: number | null = 1): WorkerReportRecord => {
  const at = new Date(Date.parse(WINDOW.since) + 12 * 3_600_000 + eventId * 60_000).toISOString();
  const spawnedAt = hours === null ? null : new Date(Date.parse(at) - hours * 3_600_000).toISOString();
  return { eventId, at, agent, coordinator: "coord-a", spawnedAt, body };
};

const signal = (cluster: LogSignal["cluster"], hours: number, kind: LogSignal["kind"] = "wait"): LogSignal => ({ cluster, kind, at: WINDOW.since, hours, detail: "x" });
const log = (agent: string, signals: LogSignal[]): AgentLog => ({ agent, sessions: [`s-${agent}`], signals });

describe("pulling friction out of a report", () => {
  it("takes only Friction: lines when the report has one", () => {
    const body = "Status: DONE\nPR: o/r#1\nConcerns: CI took ages\nFriction: classifier denied git push twice";

    expect(extractFriction(body)).toEqual([{ source: "friction", text: "classifier denied git push twice" }]);
  });

  it("falls back to inline Concerns: when no Friction: line is present", () => {
    expect(extractFriction("Status: DONE\nConcerns: the brief named a file that does not exist")).toEqual([
      { source: "concerns", text: "the brief named a file that does not exist" },
    ]);
  });

  it("reads up to three bullet concerns under a bare Concerns: header", () => {
    const body = "Status: DONE_WITH_CONCERNS\nConcerns:\n- one\n- two\n- three\n- four\nNotes: none";

    expect(extractFriction(body).map((l) => l.text)).toEqual(["one", "two", "three"]);
  });

  it("labels blocked lines as blocked and skips a bare Status: BLOCKED", () => {
    const body = "Status: BLOCKED\nBLOCKED on gh rate limit for the second time\nConcerns: none";

    expect(extractFriction(body)).toEqual([{ source: "blocked", text: "BLOCKED on gh rate limit for the second time" }]);
  });

  it("treats Friction: none and Concerns: none as nothing said", () => {
    expect(extractFriction("Status: DONE\nFriction: none\nConcerns: none.")).toEqual([]);
  });

  it("clips a line to 200 characters", () => {
    expect(extractFriction(`Status: DONE\nFriction: ${"x".repeat(300)}`)[0]!.text).toHaveLength(200);
  });
});

describe("clustering report lines", () => {
  it.each([
    ["auto-mode classifier denied the merge call", "denials"],
    ["the leak guard blocked a read-only find", "denials"],
    ["waited 40 min on CI checks for o/r#12", "ci-wait"],
    ["timeline.test.ts is flaky on main", "flaky-test"],
    ["the agent-chat broker socket dropped twice", "broker-infra"],
    ["pytest is not installed in the worktree", "broker-infra"],
    ["three fix rounds on reviewer nits", "review-loop"],
    ["brief was unclear about which package owns it", "missing-context"],
    ["out of scope and unchanged: the re-put still moves ended_at", "scope-note"],
    ["Reviewer should accept this or open a follow-up", "scope-note"],
    ["spent an hour on the wrong approach", "other"],
  ])("puts %j in %s", (line, cluster) => {
    expect(clusterOf(line)).toBe(cluster);
  });

  it("reads CI as a wait only when the line says it waited", () => {
    expect(clusterOf("I could not run the CI job's SQLite step")).not.toBe("ci-wait");
    expect(clusterOf("the checks sat pending for an hour")).toBe("ci-wait");
  });

  it("makes a concern that names no friction cause a scope note, but keeps a Friction: line in other", () => {
    expect(lineCluster({ source: "concerns", text: "the tab labels use the sans face" })).toBe("scope-note");
    expect(lineCluster({ source: "friction", text: "spent an hour on the wrong approach" })).toBe("other");
  });

  it("normalises ids away so two wordings of one cause read alike", () => {
    expect(normaliseFriction("Waited on CI for o/r#12 at abc1234def")).toBe(normaliseFriction("waited on ci for x/y#9 at 0123456789"));
  });
});

describe("the daily friction report", () => {
  const reports = [
    report(1, "w1", "Status: DONE\nFriction: classifier denied gh pr create", 2),
    report(2, "w2", "Status: DONE\nFriction: permission prompt denied a merge", 0.5),
    report(3, "w3", "Status: DONE\nConcerns: CI checks queued for 30 min", 3),
    report(4, "w4", "Status: DONE\nConcerns: out of scope: the old path stays", null),
  ];
  const logs = [
    log("w1", [signal("denials", 0.2, "denial"), signal("ci-wait", 0.1)]),
    log("w2", [signal("ci-wait", 1), signal("denials", 0.1, "denial")]),
    log("w3", [signal("missing-context", 0.5, "tool-error")]),
    log("w4", [signal("other", 2, "tool-error")]),
  ];
  const daily = () => frictionDailyReport({ reports, logs, window: WINDOW });

  it("ranks the log side by agent-hours", () => {
    expect(daily().logs.clusters.map((c) => [c.cluster, c.agents, c.agentHours])).toEqual([
      ["other", 1, 2],
      ["ci-wait", 2, 1.1],
      ["missing-context", 1, 0.5],
      ["denials", 2, 0.3],
    ]);
  });

  it("ranks the report side by reports and sets scope notes aside", () => {
    const { reports: side } = daily();

    expect(side).toMatchObject({ reports: 4, withFrictionField: 2, withFallback: 2, scopeNotes: 1 });
    expect(side.clusters.map((c) => [c.cluster, c.reports, c.agentHours, c.agents])).toEqual([
      ["denials", 2, 2.5, ["w1", "w2"]],
      ["ci-wait", 1, 3, ["w3"]],
    ]);
  });

  it("scores each reporting agent against its log's top named cluster", () => {
    const rows = Object.fromEntries(daily().agreementRows.map((r) => [r.agent, [r.agreement, r.logTop, r.logOnly, r.reportOnly]]));

    expect(rows).toEqual({
      w1: ["yes", "denials", ["ci-wait"], []],
      w2: ["partial", "ci-wait", ["ci-wait"], []],
      w3: ["no", "missing-context", ["missing-context"], ["ci-wait"]],
      w4: ["n/a", null, [], []],
    });
    expect(daily().agreement).toMatchObject({ yes: 1, partial: 1, no: 1, notApplicable: 1 });
  });

  it("counts an agent's report hours once per cluster, at its longest report", () => {
    const repeat = [report(1, "w1", "Status: DONE\nFriction: CI slow", 1), report(2, "w1", "Status: DONE\nFriction: CI slow again", 2)];

    expect(frictionDailyReport({ reports: repeat, logs: [], window: WINDOW }).reports.clusters[0]).toMatchObject({ reports: 2, agentHours: 2, agents: ["w1"] });
  });

  it("files a non-blocking know item that leads with the log top cluster and the agreement", () => {
    const deposit = frictionDeposit(daily(), "2030-01-01", "archive.jsonl");

    expect(deposit).toMatchObject({ asker: "friction-audit", kind: "know", depositId: "friction-daily-2030-01-01", keys: ["friction-daily"] });
    expect(deposit.summary).toBe("Friction today: other (2 agent-h, 1 of 4 agents); self-report agreement 1/3");
    expect(deposit.context.indexOf("Log-derived top 5")).toBeLessThan(deposit.context.indexOf("Report-based top 5"));
    expect(deposit.context).toContain("self-report agreement 1/3 (1 partial, 1 no; 1 with a quiet log).");
    expect(deposit.context).toContain("Only in logs: ci-wait 2, missing-context 1");
    expect(deposit).not.toHaveProperty("unblocksNow");
  });

  it("says none on a quiet day", () => {
    const quiet = frictionDailyReport({ reports: [reports[3]!], logs: [], window: WINDOW });

    expect(frictionDeposit(quiet, "2030-01-01", "a").summary).toBe("Friction today: none in the logs; self-report agreement 0/0");
    expect(renderFrictionMarkdown(quiet, "2030-01-01")).toContain("Report-based top 5:\nnone");
  });
});

describe("reading the events table", () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(":memory:");
    db.exec(EVENTS_TABLE_DDL);
  });
  afterEach(() => db.close());

  const insert = (ts: string, kind: string, actor: string, target: string, body: string | null, meta?: object) =>
    db.prepare("INSERT INTO events (ts, kind, actor, target, body, meta) VALUES (?, ?, ?, ?, ?, ?)").run(Date.parse(ts), kind, actor, target, body, meta ? JSON.stringify(meta) : null);

  it("keeps Status: messages in the window and joins each to the agent's last spawn before it", () => {
    insert("2029-12-31T20:00:00Z", "agent_spawned", "coord-a", "w1", null);
    insert("2030-01-01T09:00:00Z", "agent_spawned", "coord-a", "w1", null);
    insert("2030-01-01T10:00:00Z", "message", "w1", "coord-a", "Status: DONE\nFriction: x");
    insert("2030-01-01T10:30:00Z", "message", "w1", "coord-a", "just chatting");
    insert("2030-01-02T00:00:00Z", "message", "w1", "coord-a", "Status: DONE");

    expect(readWorkerReports(db, WINDOW)).toEqual([
      { eventId: 3, at: "2030-01-01T10:00:00.000Z", agent: "w1", coordinator: "coord-a", spawnedAt: "2030-01-01T09:00:00.000Z", body: "Status: DONE\nFriction: x" },
    ]);
  });

  it("lists worker sessions, leaving out coordinators by profile and by having spawned", () => {
    insert("2030-01-01T01:00:00Z", "agent_spawned", "human", "coord-a", null, { session_id: "s-coord", profile: "opus-coordinator" });
    insert("2030-01-01T02:00:00Z", "agent_spawned", "human", "lead", null, { session_id: "s-lead", profile: "planner" });
    insert("2030-01-01T03:00:00Z", "agent_spawned", "lead", "w1", null, { session_id: "s-w1", profile: "implementer" });
    insert("2030-01-01T04:00:00Z", "agent_resumed", "lead", "w1", null, { session_id: "s-w1b" });

    expect(readWorkerSessions(db, WINDOW.until)).toEqual([
      { agent: "w1", sessionId: "s-w1" },
      { agent: "w1", sessionId: "s-w1b" },
    ]);
  });

  it("reads each agent's messages from its spawner, not from peers", () => {
    insert("2030-01-01T03:00:00Z", "agent_spawned", "lead", "w1", null);
    insert("2030-01-01T04:00:00Z", "message", "lead", "w1", "Correction to your brief: use main");
    insert("2030-01-01T05:00:00Z", "message", "peer", "w1", "hi");

    expect(readSpawnerMessages(db, WINDOW)).toEqual([{ agent: "w1", at: "2030-01-01T04:00:00.000Z", body: "Correction to your brief: use main" }]);
  });
});
