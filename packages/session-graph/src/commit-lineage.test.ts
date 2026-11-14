import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitLineage, type CommitLinks } from "./commit-lineage.js";
import { openSessionGraph, type SessionGraph } from "./graph.js";

const AT = "2026-10-20T12:00:00.000Z";

let graph: SessionGraph;
beforeEach(() => {
  graph = openSessionGraph(":memory:");
});
afterEach(() => graph.db.close());

function session(id: string, cwd: string | null = null): void {
  graph.db.prepare("INSERT INTO session (session_id, cwd, ai_title) VALUES (?, ?, ?)").run(id, cwd, `title ${id}`);
}

function pr(repo: string, num: number): string {
  const ref = `pr:${repo}#${num}`;
  graph.db.prepare("INSERT INTO pr (pr_ref, number, repo) VALUES (?, ?, ?)").run(ref, num, repo);
  return ref;
}

function linked(sessionId: string, prRef: string): void {
  graph.edges.assert({ sourceRef: `session:${sessionId}`, relation: "linked", targetRef: prRef, tValid: AT });
}

function ran(sessionId: string, taskId: string, initiative: string): void {
  graph.db.prepare("INSERT OR IGNORE INTO task (task_ref, task_id, initiative) VALUES (?, ?, ?)").run(`task:${taskId}`, taskId, initiative);
  graph.edges.assert({ sourceRef: `session:${sessionId}`, relation: "ran", targetRef: `task:${taskId}`, tValid: AT });
}

const links = (overrides: Partial<CommitLinks>): CommitLinks => ({ prNumber: null, repoName: null, trailerSessionIds: [], refTaskIds: [], ...overrides });

describe("commitLineage", () => {
  it("maps a subject's PR to the sessions linked to it, their task, and the task's other sessions", () => {
    const ref = pr("acme/demo", 42);
    session("implementer");
    session("reviewer");
    linked("implementer", ref);
    ran("implementer", "DM-7", "demo-work");
    ran("reviewer", "DM-7", "demo-work");

    const lineage = commitLineage(graph, links({ prNumber: 42, repoName: "demo" }));

    expect(lineage.prRefs).toEqual([ref]);
    expect(lineage.tasks).toEqual([{ taskId: "DM-7", initiative: "demo-work", step: "session-ran" }]);
    expect(lineage.sessions.map((s) => [s.sessionId, s.step])).toEqual([["implementer", "pr-subject"], ["reviewer", "pr-task"]]);
    expect(lineage.sessions[0]).toMatchObject({ title: "title implementer", tasks: [{ initiative: "demo-work", edges: 1 }] });
  });

  it("reads the trailer first, so a session it names keeps the trailer step", () => {
    const ref = pr("acme/demo", 42);
    session("both");
    linked("both", ref);

    const lineage = commitLineage(graph, links({ prNumber: 42, repoName: "demo", trailerSessionIds: ["both"] }));

    expect(lineage.sessions.map((s) => [s.sessionId, s.step])).toEqual([["both", "trailer"]]);
  });

  it("follows a Refs task to the sessions that ran it when no session links the PR", () => {
    session("worker");
    ran("worker", "DM-9", "demo-work");

    const lineage = commitLineage(graph, links({ prNumber: 5, repoName: "demo", refTaskIds: ["DM-9"] }));

    expect(lineage.tasks).toEqual([{ taskId: "DM-9", initiative: "demo-work", step: "refs" }]);
    expect(lineage.sessions.map((s) => [s.sessionId, s.step])).toEqual([["worker", "pr-task"]]);
  });

  it("keeps a PR number from another repo out", () => {
    linked("elsewhere", pr("acme/other", 42));

    expect(commitLineage(graph, links({ prNumber: 42, repoName: "demo" })).sessions).toEqual([]);
  });

  it("ignores an expired link", () => {
    const ref = pr("acme/demo", 42);
    linked("gone", ref);
    graph.edges.expire("session:gone", "linked", ref);

    expect(commitLineage(graph, links({ prNumber: 42, repoName: "demo" })).sessions).toEqual([]);
  });
});
