import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasTable, openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ECHO_STATE_MIGRATION_NAME } from "./echo-state-schema.js";
import { openSessionGraph } from "./graph.js";
import { MIGRATIONS } from "./schema.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-m14-"));
  file = path.join(dir, "graph.sqlite3");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("migration 14", () => {
  it("replaces a version 13 graph's session_state with echo_state keyed per transcript", () => {
    const db = openDatabase(file);
    runMigrations(db, MIGRATIONS.slice(0, 13));
    expect(hasTable(db, "session_state")).toBe(true);
    db.close();

    const graph = openSessionGraph(file);
    const keyColumns = graph.db.prepare("SELECT name, pk FROM pragma_table_info('echo_state') WHERE pk > 0 ORDER BY pk").all();

    expect(hasTable(graph.db, "session_state")).toBe(false);
    expect(keyColumns).toEqual([
      { name: "transcript_id", pk: 1 },
      { name: "session_id", pk: 2 },
      { name: "key", pk: 3 },
    ]);
    expect(ECHO_STATE_MIGRATION_NAME).toBe("echo state per transcript");
    graph.db.close();
  });
});
