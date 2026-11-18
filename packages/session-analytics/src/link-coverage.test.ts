import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureGraph, insertOrigin, insertRequest, insertTaskEdge, type FixtureGraph } from "./fixture.js";
import { linkCoverage } from "./link-coverage.js";

const WINDOW = { since: "2026-10-05", until: "2026-10-12" };
const INSIDE = "2026-10-07T10:00:00Z";

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
});
afterEach(() => fixture.close());

interface Spec {
  id: string;
  profile: string;
  ts?: string;
  tasks?: string[];
}

function addSession(spec: Spec): void {
  const db = fixture.graph.db;
  insertOrigin(db, { sessionId: spec.id, depth: 1, profile: spec.profile });
  if (spec.tasks) {
    db.prepare("UPDATE session_origin SET task_ids = ? WHERE session_id = ?").run(JSON.stringify(spec.tasks), spec.id);
    for (const task of spec.tasks) insertTaskEdge(fixture.graph, spec.id, task, "alpha");
  }
  insertRequest(db, { sessionId: spec.id, ts: spec.ts ?? INSIDE, outputTokens: 10 });
}

function linkPr(sessionId: string, number: number, state: string | null): void {
  const ref = `pr:acme/widget#${number}`;
  fixture.graph.db.prepare("INSERT OR IGNORE INTO pr (pr_ref, number, repo, state) VALUES (?, ?, 'acme/widget', ?)").run(ref, number, state);
  fixture.graph.edges.assert({ sourceRef: `session:${sessionId}`, relation: "linked", targetRef: ref });
}

function review(sessionId: string, key: string, prRef: string | null): void {
  fixture.graph.db
    .prepare("INSERT INTO pr_review (source_key, surface, verdict, ts, session_id, number, pr_ref) VALUES (?, 'chat', 'approve', ?, ?, 1, ?)")
    .run(key, INSIDE, sessionId, prRef);
}

describe("linkCoverage", () => {
  it("reports implementer shares on a mixed week", () => {
    addSession({ id: "full", profile: "implementer", tasks: ["T-1"] });
    linkPr("full", 1, "merged");
    addSession({ id: "no-state", profile: "implementer-lite", tasks: ["T-2"] });
    linkPr("no-state", 2, null);
    addSession({ id: "task-only", profile: "implementer", tasks: ["T-3"] });
    addSession({ id: "bare", profile: "implementer" });

    const { implementer } = linkCoverage(fixture.openReadOnly(), WINDOW);

    expect(implementer).toEqual({
      sessions: 4,
      withTasks: 3,
      withPr: 2,
      withTaskPrState: 1,
      taskShare: 0.75,
      prShare: 0.5,
      outcomeShare: 0.25,
    });
  });

  it("reports the reviewer share with a resolved review", () => {
    addSession({ id: "rev-a", profile: "reviewer" });
    review("rev-a", "chat:t1:0", "pr:acme/widget#1");
    addSession({ id: "rev-b", profile: "relay-reviewer" });
    review("rev-b", "chat:t2:0", null);
    addSession({ id: "rev-c", profile: "reviewer" });

    const { reviewer } = linkCoverage(fixture.openReadOnly(), WINDOW);

    expect(reviewer).toEqual({ sessions: 3, withResolvedReview: 1, share: 1 / 3 });
  });

  it("excludes a session whose requests fall outside the window", () => {
    addSession({ id: "old", profile: "implementer", ts: "2026-09-01T00:00:00Z", tasks: ["T-1"] });
    addSession({ id: "in", profile: "implementer" });

    const { implementer } = linkCoverage(fixture.openReadOnly(), WINDOW);

    expect(implementer.sessions).toBe(1);
    expect(implementer.withTasks).toBe(0);
  });

  it("does not count an expired linked edge", () => {
    addSession({ id: "s", profile: "implementer", tasks: ["T-1"] });
    linkPr("s", 1, "merged");
    fixture.graph.db.prepare("UPDATE edge SET t_expired = '2026-10-08T00:00:00Z' WHERE relation = 'linked'").run();

    expect(linkCoverage(fixture.openReadOnly(), WINDOW).implementer.withPr).toBe(0);
  });

  it("returns zeros rather than NaN on an empty graph", () => {
    const report = linkCoverage(fixture.openReadOnly(), WINDOW);

    expect(report.implementer).toEqual({ sessions: 0, withTasks: 0, withPr: 0, withTaskPrState: 0, taskShare: 0, prShare: 0, outcomeShare: 0 });
    expect(report.reviewer).toEqual({ sessions: 0, withResolvedReview: 0, share: 0 });
  });
});
