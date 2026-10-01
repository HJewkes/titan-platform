import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheTtlReport } from "./cache-ttl.js";
import { costReport } from "./cost-report.js";
import { SCENARIO_WINDOW, WAKE_WINDOW, createFixtureGraph, seedCostScenario, seedWakeScenario, type FixtureGraph } from "./fixture.js";
import { LIST_PRICE_CAVEAT, renderCostReportSections } from "./render-text.js";

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
});
afterEach(() => fixture.close());

const sessionsOf = (report: ReturnType<typeof costReport>) => report.topSessions.map((s) => s.sessionId).sort();

describe("report scope", () => {
  it("an empty scope reports the same as no scope", () => {
    seedCostScenario(fixture);
    const db = fixture.openReadOnly();

    expect(costReport(db, { ...SCENARIO_WINDOW, scope: {} })).toEqual(costReport(db, SCENARIO_WINDOW));
  });

  it("keeps only the listed sessions", () => {
    seedCostScenario(fixture);
    const db = fixture.openReadOnly();

    const report = costReport(db, { ...SCENARIO_WINDOW, scope: { sessionIds: ["worker", "miner"] } });

    expect(sessionsOf(report)).toEqual(["miner", "worker"]);
    expect(report.totals).toMatchObject({ requests: 2, sessions: 2 });
  });

  it("keeps only the listed roles", () => {
    seedCostScenario(fixture);
    const db = fixture.openReadOnly();
    const workerRole = costReport(db, SCENARIO_WINDOW).topSessions.find((s) => s.sessionId === "worker")!.role;

    const report = costReport(db, { ...SCENARIO_WINDOW, scope: { roles: [workerRole] } });

    expect(report.byRole.map((b) => b.key)).toEqual([workerRole]);
    expect(sessionsOf(report)).toEqual(["worker"]);
  });

  it("keeps sessions whose agent name starts with the prefix, and ANDs it with the other fields", () => {
    seedWakeScenario(fixture);
    const db = fixture.openReadOnly();

    expect(sessionsOf(costReport(db, { ...WAKE_WINDOW, scope: { agentPrefix: "seat-" } }))).toEqual(["seat-a", "seat-b"]);
    expect(sessionsOf(costReport(db, { ...WAKE_WINDOW, scope: { agentPrefix: "seat-", sessionIds: ["seat-b", "impl"] } }))).toEqual(["seat-b"]);
  });

  it("narrows the cache TTL what-if the same way", () => {
    seedCostScenario(fixture);
    const db = fixture.openReadOnly();

    const whatIf = cacheTtlReport(db, { ...SCENARIO_WINDOW, scope: { sessionIds: ["coord"] } });

    expect(whatIf.totals.sessions).toBe(1);
    expect(cacheTtlReport(db, SCENARIO_WINDOW).totals.sessions).toBeGreaterThan(1);
  });
});

describe("renderCostReportSections", () => {
  it("renders only the chosen sections, framed by the header, the caveat and the footer", () => {
    seedCostScenario(fixture);
    const report = costReport(fixture.openReadOnly(), SCENARIO_WINDOW);

    const text = renderCostReportSections(report, ["byAction", "mechanicalShare"]);

    expect(text.startsWith("Cost report, 2026-09-20 to 2026-09-21")).toBe(true);
    expect(text).toContain("By action per role");
    expect(text).toContain("Mechanical share: ");
    expect(text).not.toContain("By token class");
    expect(text).toContain(LIST_PRICE_CAVEAT);
    expect(text.trimEnd().split("\n").at(-1)).toMatch(/^Price table v\d+\. Coverage: /);
  });
});
