import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costReport } from "./cost-report.js";
import { createFixtureGraph, insertPrices, insertRequest, insertSession, insertTaskEdge, type FixtureGraph } from "./fixture.js";
import { initiativeFromCwd, sessionInitiative } from "./initiative.js";

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
});
afterEach(() => fixture.close());

describe("initiative", () => {
  it("initiative prefers a task edge over the cwd rule", () => {
    const db = fixture.graph.db;
    insertPrices(db);
    insertSession(db, { sessionId: "tasked", cwd: "/Users/h/projects/titan-platform" });
    insertSession(db, { sessionId: "untasked", cwd: "/Users/h/projects/titan-platform" });
    insertTaskEdge(fixture.graph, "tasked", "TP-272", "session-mining-audit");
    insertRequest(db, { sessionId: "tasked", ts: "2026-09-20T10:00:00Z", inputTokens: 10 });
    insertRequest(db, { sessionId: "untasked", ts: "2026-09-20T10:00:00Z", inputTokens: 10 });

    const byInitiative = costReport(fixture.openReadOnly()).byInitiative;

    expect(byInitiative.map(({ key, sessions }) => ({ key, sessions }))).toEqual([
      { key: "repo:titan-platform", sessions: 1 },
      { key: "session-mining-audit", sessions: 1 },
    ]);
  });

  it("picks the most-named initiative, then the alphabetically first", () => {
    expect(sessionInitiative([{ initiative: "b", edges: 1 }, { initiative: "a", edges: 3 }], "/x")).toBe("a");
    expect(sessionInitiative([{ initiative: "b", edges: 2 }, { initiative: "a", edges: 2 }], "/x")).toBe("a");
  });

  it("applies the cf_analyze cwd rule in order", () => {
    expect(initiativeFromCwd("/Users/h/projects/relay/.worktrees/x")).toBe("repo:relay");
    expect(initiativeFromCwd("/Users/h/Library/Application Support/active-work/titan-platform/notes")).toBe("active-work:titan-platform");
    expect(initiativeFromCwd("/tmp/ac-fork-abc123")).toBe("ac-fork(tmp)");
    expect(initiativeFromCwd("/tmp/scratch/")).toBe("other:scratch");
    expect(initiativeFromCwd(null)).toBe("unknown");
  });
});
