import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionsTouchingFiles } from "./files-touched.js";
import { openSessionGraph, type SessionGraph } from "./graph.js";

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const daysAgo = (days: number): string => new Date(NOW - days * 86_400_000).toISOString();

let graph: SessionGraph;
beforeEach(() => {
  graph = openSessionGraph(":memory:");
});
afterEach(() => graph.db.close());

function file(repo: string, path: string): string {
  const ref = `file:${repo}/${path}`;
  graph.db.prepare("INSERT OR IGNORE INTO file (file_ref, repo, path) VALUES (?, ?, ?)").run(ref, repo, path);
  return ref;
}

function session(id: string, touched: string[], at: string, fields: { cwd?: string; title?: string } = {}): void {
  graph.db.prepare("INSERT INTO session (session_id, cwd, ai_title) VALUES (?, ?, ?)").run(id, fields.cwd ?? null, fields.title ?? null);
  for (const ref of touched) graph.edges.assert({ sourceRef: `session:${id}`, relation: "touched", targetRef: ref, tValid: at });
}

function ranTask(sessionId: string, taskId: string, initiative: string): void {
  graph.db.prepare("INSERT OR IGNORE INTO task (task_ref, task_id, initiative) VALUES (?, ?, ?)").run(`task:${taskId}`, taskId, initiative);
  graph.edges.assert({ sourceRef: `session:${sessionId}`, relation: "ran", targetRef: `task:${taskId}`, tValid: daysAgo(1) });
}

describe("sessionsTouchingFiles", () => {
  it("returns only sessions that touched the file inside the window", () => {
    const target = file("demo", "src/app.ts");
    session("recent", [target], daysAgo(3), { cwd: "/work/demo", title: "Fix the app" });
    session("stale", [target], daysAgo(20));

    const rows = sessionsTouchingFiles(graph, { files: [{ path: "src/app.ts" }], since: daysAgo(14) });

    expect(rows).toEqual([
      { sessionId: "recent", touchedAt: daysAgo(3), cwd: "/work/demo", title: "Fix the app", fileRefs: [target], tasks: [] },
    ]);
  });

  it("orders newest first and stops at the limit", () => {
    const target = file("demo", "src/app.ts");
    session("one", [target], daysAgo(5));
    session("two", [target], daysAgo(1));
    session("three", [target], daysAgo(2));

    const rows = sessionsTouchingFiles(graph, { files: [{ path: "src/app.ts" }], since: daysAgo(14), limit: 2 });

    expect(rows.map((row) => row.sessionId)).toEqual(["two", "three"]);
  });

  it("matches a path in the named repo only when a repo is given", () => {
    const mine = file("demo", "src/app.ts");
    const theirs = file("other", "src/app.ts");
    session("in-demo", [mine], daysAgo(1));
    session("in-other", [theirs], daysAgo(1));

    const rows = sessionsTouchingFiles(graph, { files: [{ repo: "demo", path: "src/app.ts" }], since: daysAgo(14) });

    expect(rows.map((row) => row.sessionId)).toEqual(["in-demo"]);
  });

  it("lists every named file a session touched and the initiatives its tasks name", () => {
    const app = file("demo", "src/app.ts");
    const lib = file("demo", "src/lib.ts");
    session("both", [lib, app], daysAgo(2));
    ranTask("both", "DM-1", "demo-work");

    const [row] = sessionsTouchingFiles(graph, { files: [{ path: "src/app.ts" }, { path: "src/lib.ts" }], since: daysAgo(14) });

    expect(row).toMatchObject({ fileRefs: [app, lib], tasks: [{ initiative: "demo-work", edges: 1 }] });
  });

  it("returns nothing for a file no session touched", () => {
    session("elsewhere", [file("demo", "src/app.ts")], daysAgo(1));

    expect(sessionsTouchingFiles(graph, { files: [{ path: "src/unknown.ts" }], since: daysAgo(14) })).toEqual([]);
  });
});
