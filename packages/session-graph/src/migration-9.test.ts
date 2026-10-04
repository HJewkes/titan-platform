import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasTable, openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, resetIndex } from "./graph.js";
import { refreshCorpus } from "./refresh.js";
import { NORMALIZED_TABLES, MIGRATIONS } from "./schema.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-m9-"));
  file = path.join(dir, "graph.sqlite3");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function versionEightGraph(): void {
  const db = openDatabase(file);
  runMigrations(db, MIGRATIONS.slice(0, 8));
  db.close();
}

describe("migration 9", () => {
  it("leaves a fresh graph with no artifact table and no normalized tables", () => {
    const graph = openSessionGraph(file);
    expect(hasTable(graph.db, "artifact")).toBe(false);
    for (const t of NORMALIZED_TABLES) expect(hasTable(graph.db, t)).toBe(false);
    expect(hasTable(graph.db, "session_state")).toBe(true);
    graph.db.close();
  });

  it("drops the artifact table and the empty normalized tables of a version 8 graph", () => {
    versionEightGraph();
    const graph = openSessionGraph(file);
    expect(hasTable(graph.db, "artifact")).toBe(false);
    for (const t of NORMALIZED_TABLES) expect(hasTable(graph.db, t)).toBe(false);
    graph.db.close();
  });

  it("re-creates the normalized tables when opened with normalized: true", () => {
    const graph = openSessionGraph(file, { normalized: true });
    for (const t of NORMALIZED_TABLES) expect(hasTable(graph.db, t)).toBe(true);
    graph.db.close();
  });

  it("keeps normalized tables that hold rows", () => {
    versionEightGraph();
    const db = openDatabase(file);
    db.prepare("INSERT INTO normalized_source VALUES (1, 'src', 'ref', '{}')").run();
    db.close();

    const graph = openSessionGraph(file);
    expect(graph.db.prepare("SELECT count(*) AS n FROM normalized_source").get()).toEqual({ n: 1 });
    expect(() => resetIndex(graph)).not.toThrow();
    expect(graph.db.prepare("SELECT count(*) AS n FROM normalized_source").get()).toEqual({ n: 0 });
    graph.db.close();
  });

  it("runs resetIndex and a refresh pass clean on a graph without the opt-in tables", async () => {
    const graph = openSessionGraph(file);
    const transcript = path.join(dir, "s1.jsonl");
    writeFileSync(transcript, "");
    graph.transcripts.ensure("~/s1.jsonl");

    expect(() => resetIndex(graph)).not.toThrow();
    const pass = await refreshCorpus(graph, [], { homeDir: dir });
    expect(pass.markedMissing).toBe(0);
    graph.db.close();
  });

  it("expands ~ before checking whether a vanished source exists", async () => {
    const graph = openSessionGraph(file);
    writeFileSync(path.join(dir, "gone.jsonl"), "");
    graph.transcripts.ensure("~/gone.jsonl");
    graph.transcripts.ensure("~/never-there.jsonl");

    const pass = await refreshCorpus(graph, [], { homeDir: dir });

    expect(pass.markedMissing).toBe(1);
    expect(graph.transcripts.get("~/gone.jsonl")?.status).toBe("ok");
    expect(graph.transcripts.get("~/never-there.jsonl")?.status).toBe("missing");
    graph.db.close();
  });

  it("does not mark a source missing when the caller lists it as present", async () => {
    const graph = openSessionGraph(file);
    graph.transcripts.ensure("~/sealed.jsonl");

    const pass = await refreshCorpus(graph, [], { homeDir: dir, present: ["~/sealed.jsonl"] });

    expect(pass.markedMissing).toBe(0);
    graph.db.close();
  });
});
