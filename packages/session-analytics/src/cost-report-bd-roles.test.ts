import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costReport } from "./cost-report.js";
import { createFixtureGraph, insertOrigin, insertPrices, insertRequest, insertSession, type FixtureGraph } from "./fixture.js";

const WINDOW = { since: "2026-09-20", until: "2026-09-21" } as const;
const BD_ROLES = {
  "bd-implementer": "worker:implementer",
  "bd-implementer-lite": "worker:implementer",
  "bd-reviewer": "worker:reviewer",
  "bd-planner": "worker:planner",
};

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
  insertPrices(fixture.graph);
  const db = fixture.graph.db;
  Object.keys(BD_ROLES).forEach((profile, index) => {
    insertSession(db, { sessionId: profile, startType: "sdk-cli" });
    insertOrigin(db, { sessionId: profile, depth: 1, profile, parentName: "coord" });
    insertRequest(db, { sessionId: profile, ts: `2026-09-20T1${index}:00:00Z`, inputTokens: 100, outputTokens: 10, wakeCause: "tool_result", wakeDelivery: "tool_result" });
  });
});
afterEach(() => fixture.close());

describe("costReport with bd-* profiles", () => {
  it("reports each bd-* profile under its twin's role and never as worker:unknown", () => {
    const report = costReport(fixture.openReadOnly(), WINDOW);
    const roles = report.byRole.map((bucket) => bucket.key).sort();

    expect(roles).not.toContain("worker:unknown");
    expect(roles).toEqual(["worker:implementer", "worker:planner", "worker:reviewer"]);
    expect(report.byRole.find((bucket) => bucket.key === "worker:implementer")?.sessions).toBe(2);
  });
});
