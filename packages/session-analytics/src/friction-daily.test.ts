import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENTS_TABLE_DDL, readWorkerReports, type WorkerReportRecord } from "./events-db.js";
import { frictionDailyReport, frictionDeposit, renderFrictionMarkdown } from "./friction-daily.js";
import { clusterOf, extractFriction, normaliseFriction } from "./friction-lines.js";

const WINDOW = { since: "2030-01-01T00:00:00.000Z", until: "2030-01-02T00:00:00.000Z" };

const report = (eventId: number, agent: string, body: string, hours: number | null = 1): WorkerReportRecord => {
  const at = new Date(Date.parse(WINDOW.since) + 12 * 3_600_000 + eventId * 60_000).toISOString();
  const spawnedAt = hours === null ? null : new Date(Date.parse(at) - hours * 3_600_000).toISOString();
  return { eventId, at, agent, coordinator: "coord-a", spawnedAt, body };
};

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

describe("clustering friction lines", () => {
  it.each([
    ["auto-mode classifier denied the merge call", "denials"],
    ["waited 40 min on CI checks for o/r#12", "ci-wait"],
    ["timeline.test.ts is flaky on main", "flaky-test"],
    ["the agent-chat broker socket dropped twice", "broker-infra"],
    ["three fix rounds on reviewer nits", "review-loop"],
    ["brief was unclear about which package owns it", "missing-context"],
    ["spent an hour on the wrong approach", "other"],
  ])("puts %j in %s", (line, cluster) => {
    expect(clusterOf(line)).toBe(cluster);
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
    report(4, "w4", "Status: DONE\nConcerns: none", null),
  ];

  it("ranks clusters by reports, then agent-hours, and counts the field and the fallback apart", () => {
    const daily = frictionDailyReport(reports, WINDOW);

    expect(daily).toMatchObject({ reports: 4, withFrictionField: 2, withFallback: 1 });
    expect(daily.clusters.map((c) => [c.cluster, c.reports, c.agentHours, c.agents])).toEqual([
      ["denials", 2, 2.5, ["w1", "w2"]],
      ["ci-wait", 1, 3, ["w3"]],
    ]);
  });

  it("counts an agent's hours once per cluster, at its longest report", () => {
    const repeat = [report(1, "w1", "Status: DONE\nFriction: CI slow", 1), report(2, "w1", "Status: DONE\nFriction: CI slow again", 2)];

    expect(frictionDailyReport(repeat, WINDOW).clusters[0]).toMatchObject({ reports: 2, agentHours: 2, agents: ["w1"] });
  });

  it("files a non-blocking know item naming the top cluster and its share of reports", () => {
    const deposit = frictionDeposit(frictionDailyReport(reports, WINDOW), "2030-01-01", "archive.jsonl");

    expect(deposit).toMatchObject({ asker: "friction-audit", kind: "know", depositId: "friction-daily-2030-01-01", keys: ["friction-daily"] });
    expect(deposit.summary).toBe("Friction today: denials (2 of 4 reports)");
    expect(deposit.context).toContain("1. denials: 2 of 4 reports, 2.5 agent-hours; e.g. w1, w2");
    expect(deposit).not.toHaveProperty("unblocksNow");
  });

  it("says none reported on a quiet day", () => {
    const quiet = frictionDailyReport([reports[3]!], WINDOW);

    expect(frictionDeposit(quiet, "2030-01-01", "a").summary).toBe("Friction today: none reported (0 of 1 reports)");
    expect(renderFrictionMarkdown(quiet, "2030-01-01")).toContain("No friction reported.");
  });
});

describe("reading worker reports from the events table", () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(":memory:");
    db.exec(EVENTS_TABLE_DDL);
  });
  afterEach(() => db.close());

  const insert = (ts: string, kind: string, actor: string, target: string, body: string | null) =>
    db.prepare("INSERT INTO events (ts, kind, actor, target, body) VALUES (?, ?, ?, ?, ?)").run(Date.parse(ts), kind, actor, target, body);

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
});
