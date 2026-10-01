import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSessionGraph } from "@titan-design/session-graph";
import { openDatabase, runMigrations, type Migration } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { resolveConfig } from "./config.js";
import { createMinerContext } from "./context.js";
import { FIXTURE_WINDOW, seedInsightGraph } from "./insights/fixture.js";
import { spendByAction } from "./insights/questions.js";
import { MINER_MIGRATIONS } from "./schema.js";

/** A synthetic stand-in for another owner's band on the shared graph, numbered where active-work's sits. */
const CO_OWNER_MIGRATIONS: Migration[] = [
  { version: 1001, name: "workspace index tables", up: (db) => db.exec("CREATE TABLE workspace_file (path TEXT PRIMARY KEY)") },
  { version: 1002, name: "preserved rows", up: (db) => db.exec("CREATE TABLE preserved_row (id INTEGER PRIMARY KEY)") },
];

let dir: string;
let stateDir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-shared-"));
  stateDir = path.join(dir, "state");
  mkdirSync(stateDir);
  dbPath = path.join(stateDir, "index.sqlite3");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedCoOwnedGraph(file: string): void {
  const graph = openSessionGraph(file);
  runMigrations(graph.db, CO_OWNER_MIGRATIONS);
  seedInsightGraph(graph.db);
  graph.db.close();
}

function migrationRows(file: string): { version: number; name: string }[] {
  const db = openDatabase(file, { readonly: true });
  try {
    return db.prepare("SELECT version, name FROM _migration ORDER BY version").all() as { version: number; name: string }[];
  } finally {
    db.close();
  }
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io = { stdout: (t: string) => void (stdout += t), stderr: (t: string) => void (stderr += t), env: {} };
  const code = await runCli(["--state", stateDir, "--corpus", path.join(dir, "corpus"), ...args], io);
  return { code, stdout, stderr };
}

function askSpendByAction(extra: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  return cli([...extra, "--json", "insights", spendByAction.name, "--since", FIXTURE_WINDOW.since, "--until", FIXTURE_WINDOW.until]);
}

describe("a graph another owner has also migrated", () => {
  it("takes the miner's migrations without colliding and answers an insights question", async () => {
    seedCoOwnedGraph(dbPath);

    const { code, stdout } = await askSpendByAction();

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { question: spendByAction.id, answer: { totals: { sessions: 3 } } } });
    expect(migrationRows(dbPath)).toEqual(expect.arrayContaining([...CO_OWNER_MIGRATIONS, ...MINER_MIGRATIONS].map(({ version, name }) => ({ version, name }))));
  });

  it("opens read-only through --graph, answers, and leaves the file byte-identical", async () => {
    const foreign = path.join(dir, "foreign.sqlite3");
    seedCoOwnedGraph(foreign);
    const before = readFileSync(foreign);

    const { code, stdout } = await askSpendByAction(["--graph", foreign]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { answer: { totals: { sessions: 3 } } } });
    expect(readFileSync(foreign).equals(before)).toBe(true);
  });

  it("refuses a write command on a read-only graph", async () => {
    const foreign = path.join(dir, "foreign.sqlite3");
    seedCoOwnedGraph(foreign);

    const { code, stdout } = await cli(["--graph", foreign, "--json", "playbook", "add", "Pin npm in release jobs"]);

    expect(code).not.toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false });
    expect(migrationRows(foreign).map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 1001, 1002]);
  });
});

describe("a miner database migrated before the band moved", () => {
  it("opens under the renumbered band and keeps its playbook", () => {
    const legacy = openSessionGraph(dbPath);
    runMigrations(legacy.db, legacyMinerMigrations());
    legacy.db.close();
    const ctx = createMinerContext(resolveConfig({ stateDir, corpusRoot: path.join(dir, "corpus") }, {}));

    try {
      ctx.playbook().add({ content: "Pin npm in release jobs" });

      expect(ctx.playbook().list().map((b) => b.content)).toEqual(["Pin npm in release jobs"]);
      expect(migrationRows(dbPath).map((r) => r.version).filter((v) => v >= 1000)).toEqual([1000, 1001, 1002, 2000, 2001, 2002]);
    } finally {
      ctx.close();
    }
  });
});

/** The list as it shipped before TP-635: the same tables at 1000, 1001 and 1002. */
function legacyMinerMigrations(): Migration[] {
  return MINER_MIGRATIONS.map((m, i) => ({ ...m, version: 1000 + i }));
}
