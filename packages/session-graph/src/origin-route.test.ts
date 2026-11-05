import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph } from "./graph.js";
import { ORIGIN_ROUTE_COLUMNS, ORIGIN_ROUTE_MIGRATION_NAME } from "./origin-route-schema.js";
import { resolveOrigins } from "./origin.js";
import { MIGRATIONS } from "./schema.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-route-"));
  file = path.join(dir, "graph.sqlite3");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("origin route columns", () => {
  it("round-trip through an origin resolution and clear on a re-resolution without them", async () => {
    const graph = openSessionGraph(":memory:");
    graph.db.prepare("INSERT INTO session (session_id, cwd) VALUES ('worker', '/scratch')").run();

    await resolveOrigins(graph, () => ({
      origins: { worker: { originSystem: "agent-chat", taskIds: [], routeSource: "plan-slice", routePrior: "small", routeFacts: '{"owns":true}' } },
    }));
    const stored = graph.db.prepare("SELECT route_source, route_prior, route_facts, route_mode FROM session_origin").get();
    graph.db.prepare("UPDATE session SET ended_at = '2999-01-01T00:00:00Z'").run();
    await resolveOrigins(graph, () => ({ origins: { worker: { originSystem: "agent-chat", taskIds: [] } } }));
    const cleared = graph.db.prepare("SELECT route_source, route_facts FROM session_origin").get();

    expect(stored).toEqual({ route_source: "plan-slice", route_prior: "small", route_facts: '{"owns":true}', route_mode: null });
    expect(cleared).toEqual({ route_source: null, route_facts: null });
    graph.db.close();
  });

  it("are added to a version 14 database by a named migration, keeping its rows", () => {
    const old = openDatabase(file);
    runMigrations(old, MIGRATIONS.slice(0, 14));
    old.exec("INSERT INTO session (session_id, cwd) VALUES ('kept', '/scratch')");
    old.exec("INSERT INTO session_origin (session_id, origin_system, resolved_at) VALUES ('kept', 'agent-chat', '2026-01-01T00:00:00Z')");
    old.close();

    const graph = openSessionGraph(file);
    const columns = graph.db.prepare("SELECT name FROM pragma_table_info('session_origin')").pluck().all();
    const applied = graph.db.prepare("SELECT name FROM _migration").pluck().all();
    const kept = graph.db.prepare("SELECT route_table FROM session_origin WHERE session_id = 'kept'").get();

    expect(columns).toEqual(expect.arrayContaining([...ORIGIN_ROUTE_COLUMNS]));
    expect(applied).toContain(ORIGIN_ROUTE_MIGRATION_NAME);
    expect(kept).toEqual({ route_table: null });
    graph.db.close();
  });
});
