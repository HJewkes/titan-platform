import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@titan-design/store-sqlite";
import { foldSpawns, readLifecycleRows, type LifecycleRow } from "./coord-spawns.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-coord-spawns-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function seed(rows: ReadonlyArray<[ts: number, kind: string, actor: string, target: string | null, meta: string]>): string {
  const file = path.join(dir, "events.db");
  const db = openDatabase(file);
  db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)");
  const insert = db.prepare("INSERT INTO events (ts, kind, actor, target, meta) VALUES (?, ?, ?, ?, ?)");
  for (const row of rows) insert.run(...row);
  db.close();
  return file;
}

const row = (kind: string, actor: string, target: string | null, fields: Partial<LifecycleRow> = {}): LifecycleRow => ({
  kind, actor, target, ts: 1, name: null, repo: null, branch: null, task: null, role: null, origin: null, cost: null, ...fields,
});

describe("readLifecycleRows", () => {
  it("reads lifecycle rows since the cut-off, skips messages, and survives a malformed meta", () => {
    const file = seed([
      [5, "agent_spawned", "coord", "early", JSON.stringify({ name: "early" })],
      [10, "agent_spawned", "coord", "impl", JSON.stringify({ name: "impl", task: "EX-1", work_role: "reviewer" })],
      [11, "message", "coord", "impl", "{}"],
      [12, "agent_exited", "impl", null, "not json"],
    ]);

    const rows = readLifecycleRows(file, 10);

    expect(rows?.map((entry) => [entry.kind, entry.actor, entry.task, entry.role])).toEqual([
      ["agent_spawned", "coord", "EX-1", "reviewer"],
      ["agent_exited", "impl", null, null],
    ]);
  });

  it("is null when events.db lacks a column it reads", () => {
    const file = path.join(dir, "events.db");
    const db = openDatabase(file);
    db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, actor TEXT)");
    db.close();

    expect(readLifecycleRows(file, 0)).toBeNull();
  });
});

describe("foldSpawns", () => {
  it("drops adopted sessions, marks reviewers as non-implementers and strips the initiative from a task", () => {
    const spawns = foldSpawns([
      row("agent_spawned", "human", "adopted", { origin: "adopted" }),
      row("agent_spawned", "coord", "rev", { role: "reviewer", task: "example/EX-1" }),
    ]);

    expect(spawns).toMatchObject([{ name: "rev", spawnedBy: "coord", implementer: false, task: "EX-1", live: true }]);
  });

  it("ends the older run of a respawned name and applies a later exit to the newest spawn", () => {
    const spawns = foldSpawns([row("agent_spawned", "coord", "impl"), row("agent_spawned", "coord", "impl"), row("agent_exited", "impl", null, { cost: 2 })]);

    expect(spawns.map((spawn) => [spawn.live, spawn.costUsd])).toEqual([
      [false, null],
      [false, 2],
    ]);
  });
});
