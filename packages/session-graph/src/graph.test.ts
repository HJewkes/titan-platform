import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionGraphNotMigratedError, openSessionGraph } from "./graph.js";
import { MIGRATIONS } from "./schema.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-open-"));
  file = path.join(dir, "graph.sqlite3");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("opening a graph read-only", () => {
  it("reads a fully migrated graph and refuses to write to it", () => {
    openSessionGraph(file).db.close();
    const before = readFileSync(file);

    const graph = openSessionGraph(file, { readonly: true });
    try {
      expect(graph.transcripts.list()).toEqual([]);
      expect(() => graph.db.exec("CREATE TABLE scratch (id INTEGER)")).toThrow(/readonly/);
    } finally {
      graph.db.close();
    }
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("refuses a graph missing a session-graph migration instead of applying it", () => {
    const db = openDatabase(file);
    runMigrations(db, MIGRATIONS.slice(0, 2));
    db.close();

    expect(() => openSessionGraph(file, { readonly: true })).toThrow(SessionGraphNotMigratedError);
    expect(() => openSessionGraph(file, { readonly: true })).toThrow(/^the graph does not carry session-graph migrations 3 /);
  });
});
