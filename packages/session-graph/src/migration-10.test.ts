import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph } from "./graph.js";
import { syncPrices } from "./prices.js";
import { MIGRATIONS } from "./schema.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-m10-"));
  file = path.join(dir, "graph.sqlite3");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const OPUS = { modelPrefix: "claude-opus-5", effectiveFrom: "2026-01-01", input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 };

function versionNineGraphWithUnlistedRequest(): void {
  const db = openDatabase(file);
  runMigrations(db, MIGRATIONS.slice(0, 9));
  db.prepare(
    "INSERT INTO request (transcript_id, request_id, byte_offset, session_id, ts, model, input_tokens) VALUES (1, 'r', 0, 's', '2026-09-01T00:00:00Z', 'claude-opus-5-9', 1000000)",
  ).run();
  db.close();
}

describe("migration 10", () => {
  it("recreates request_cost on a version 9 graph so an unlisted model stops taking a shorter prefix's rate", () => {
    versionNineGraphWithUnlistedRequest();
    const before = openDatabase(file);
    before.prepare("INSERT INTO price VALUES ('claude-opus-5', '2026-01-01', 1, 5, 0.5, 6.25, 10, 25, NULL)").run();
    expect(before.prepare("SELECT priced FROM request_cost").get()).toEqual({ priced: 1 });
    before.close();

    const graph = openSessionGraph(file);
    syncPrices(graph, [OPUS], { tableVersion: 1 });

    expect(graph.db.prepare("SELECT priced, cost_usd FROM request_cost").get()).toEqual({ priced: 0, cost_usd: 0 });
    graph.db.close();
  });
});
