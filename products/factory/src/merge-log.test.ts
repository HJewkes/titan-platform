import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { gateBriefMigration, gateDelegateMigration, gateEvidenceMigration, gateMigration, gateResolverMigration, gateRuleMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { workflowMigration, workflowOwnershipMigration } from "@titan-design/workflow";
import { z } from "zod";
import { gateAskMigration } from "./gate-ask-store.js";
import { gateBatchMigration } from "./gate-batch-store.js";
import { openFactoryHost, type FactoryRoutes } from "./host.js";
import { MERGE_PATHS } from "./merge-log.js";
import { SHEPHERD_MIGRATIONS } from "./workflows.js";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const MERGE_COMMIT = "c".repeat(40);
const REPO = "acme/widgets";
const [LANDER = "lander", SEAT_MERGE = "seat-merge"] = MERGE_PATHS;

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const tenantRoutes: FactoryRoutes = Object.assign([], { database: { extraMigrations: SHEPHERD_MIGRATIONS, bind: () => () => undefined } });

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-merge-log-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

/** A host database as main shipped it before the merge log: every host and tenant migration up to 28. */
function preMergeLogDatabase(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(7), gateBriefMigration(13), gateEvidenceMigration(14), gateBatchMigration(15), gateAskMigration(20), gateRuleMigration(27), gateDelegateMigration(28), ...SHEPHERD_MIGRATIONS]);
  db.prepare("INSERT INTO shepherd_event (repo, pr, kind, reason, actor, at, head_sha) VALUES (?, 7, 'hold', 'g10', 'shepherd', '2026-10-17T00:00:00.000Z', ?)").run(REPO, HEAD);
  db.close();
}

function hostDb(): Db {
  const dbPath = dbFile();
  openFactoryHost({ dbPath, workflows: [], routes: tenantRoutes }).close();
  const db = openDatabase(dbPath);
  dbs.push(db);
  return db;
}

interface Row {
  kind: "intent" | "result";
  intent_id: number | bigint | null;
  path: string;
  repo: string;
  pr: number;
  head_sha: string;
  outcome: "merged" | "failed" | "unknown" | null;
  merge_commit: string | null;
}

const BASE: Row = { kind: "intent", intent_id: null, path: LANDER, repo: REPO, pr: 7, head_sha: HEAD, outcome: null, merge_commit: null };

function append(db: Db, row: Partial<Row>): number | bigint {
  return db
    .prepare(
      `INSERT INTO merge_op (kind, intent_id, path, repo, pr, head_sha, reason_kind, reason_id, actor, github_login, at, outcome, merge_commit)
       VALUES (@kind, @intent_id, @path, @repo, @pr, @head_sha, 'item', 'TP-1', 'lander', 'octo-bot', '2026-10-17T00:00:00.000Z', @outcome, @merge_commit)`,
    )
    .run({ ...BASE, ...row }).lastInsertRowid;
}

function result(intentId: number | bigint, outcome: Row["outcome"], extra: Partial<Row> = {}): Partial<Row> {
  return { kind: "result", intent_id: intentId, outcome, merge_commit: outcome === "merged" ? MERGE_COMMIT : null, ...extra };
}

describe("merge_op migration", () => {
  it("opening the factory host creates merge_op at version 29", () => {
    const db = hostDb();

    const columns = z.array(z.looseObject({ name: z.string() })).parse(db.prepare("PRAGMA table_info(merge_op)").all()).map((column) => column.name);
    const migration = db.prepare("SELECT version, name FROM _migration WHERE version = 29").get();

    expect(columns).toEqual(["id", "kind", "intent_id", "path", "drain", "repo", "pr", "head_sha", "reason_kind", "reason_id", "actor", "github_login", "at", "outcome", "merge_commit"]);
    expect(migration).toEqual({ version: 29, name: "factory:merge_op" });
  });

  it("a database at version 28 migrates to 29 and keeps its rows", () => {
    const dbPath = dbFile();
    preMergeLogDatabase(dbPath);
    const migrations = (): unknown[] => {
      const db = openDatabase(dbPath);
      const rows = db.prepare("SELECT version, name, applied_at FROM _migration ORDER BY version").all();
      db.close();
      return rows;
    };

    openFactoryHost({ dbPath, workflows: [], routes: tenantRoutes }).close();
    const afterFirst = migrations();
    openFactoryHost({ dbPath, workflows: [], routes: tenantRoutes }).close();

    const db = openDatabase(dbPath);
    dbs.push(db);
    expect(db.prepare("SELECT repo, pr, kind, head_sha FROM shepherd_event").all()).toEqual([{ repo: REPO, pr: 7, kind: "hold", head_sha: HEAD }]);
    expect(afterFirst).toEqual(expect.arrayContaining([expect.objectContaining({ version: 29, name: "factory:merge_op" }), expect.objectContaining({ version: 30, name: "factory:event_log" })]));
    expect(migrations()).toEqual(afterFirst);
  });
});

describe("merge_op rows", () => {
  it("an intent then a merged result append", () => {
    const db = hostDb();

    const intentId = append(db, {});
    const resultId = append(db, result(intentId, "merged"));

    expect(Number(resultId)).toBeGreaterThan(Number(intentId));
    expect(db.prepare("SELECT kind, outcome, merge_commit FROM merge_op ORDER BY id").all()).toEqual([
      { kind: "intent", outcome: null, merge_commit: null },
      { kind: "result", outcome: "merged", merge_commit: MERGE_COMMIT },
    ]);
  });

  it("updating or deleting any row aborts", () => {
    const db = hostDb();
    const intentId = append(db, {});
    const before = db.prepare("SELECT * FROM merge_op").all();

    expect(() => db.prepare("UPDATE merge_op SET pr = 8 WHERE id = ?").run(intentId)).toThrow("merge_op is append-only");
    expect(() => db.prepare("DELETE FROM merge_op WHERE id = ?").run(intentId)).toThrow("merge_op is append-only");
    expect(db.prepare("SELECT * FROM merge_op").all()).toEqual(before);
  });

  it("a result must pair with a matching intent", () => {
    const db = hostDb();
    const intentId = append(db, {});
    const unknownId = append(db, result(intentId, "unknown"));
    const pairing = "merge_op result must name an intent of the same path, repo, pr and head";

    expect(() => append(db, result(Number(unknownId) + 100, "merged")), "missing intent").toThrow(pairing);
    expect(() => append(db, result(unknownId, "merged")), "intent id names a result").toThrow(pairing);
    expect(() => append(db, result(intentId, "merged", { repo: "acme/gadgets" })), "other repo").toThrow(pairing);
    expect(() => append(db, result(intentId, "merged", { pr: 8 })), "other pr").toThrow(pairing);
    expect(() => append(db, result(intentId, "merged", { head_sha: OTHER_HEAD })), "other head").toThrow(pairing);
    expect(() => append(db, result(intentId, "merged", { path: SEAT_MERGE })), "other path").toThrow(pairing);
    expect(() => append(db, { kind: "result", intent_id: null, outcome: "failed" }), "no intent id").toThrow(pairing);
    expect(() => append(db, { outcome: "merged", merge_commit: MERGE_COMMIT }), "intent with an outcome").toThrow(/CHECK constraint failed/);
    expect(() => append(db, { merge_commit: MERGE_COMMIT }), "intent with a merge commit").toThrow(/CHECK constraint failed/);
    expect(() => append(db, result(intentId, "merged", { merge_commit: null })), "merged without a commit").toThrow(/CHECK constraint failed/);
    expect(() => append(db, result(intentId, "failed", { merge_commit: MERGE_COMMIT })), "failed with a commit").toThrow(/CHECK constraint failed/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM merge_op").get()).toEqual({ n: 2 });
  });

  it("unknown then merged is allowed, but a second terminal result is not", () => {
    const db = hostDb();
    const intentId = append(db, {});

    append(db, result(intentId, "unknown"));
    append(db, result(intentId, "merged"));

    expect(() => append(db, result(intentId, "failed")), "failed after merged").toThrow(/UNIQUE constraint failed/);
    expect(() => append(db, result(intentId, "merged")), "merged twice").toThrow(/UNIQUE constraint failed/);
    expect(db.prepare("SELECT outcome FROM merge_op WHERE kind = 'result' ORDER BY id").all()).toEqual([{ outcome: "unknown" }, { outcome: "merged" }]);
  });
});

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage", "fixtures", "test-support"]);
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|sh|sql)$/;
const TEST = /\.test\.[a-z]+$/;
const MENTION = /merge_op|MERGE_LOG_TABLE|mergeLogMigration/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE.test(entry.name) && !TEST.test(entry.name) ? [path] : [];
  });
}

describe("merge_op consumers", () => {
  it("nothing reads or writes merge_op yet", () => {
    const mentions = ["packages", "products"].flatMap((top) => sourceFiles(join(ROOT, top))).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => MENTION.test(line))
        .map((line) => ({ file: relative(ROOT, path), line: line.trim() })),
    );

    const outside = mentions.filter((mention) => mention.file !== "products/factory/src/merge-log.ts");

    expect(outside).toEqual([
      { file: "products/factory/src/host.ts", line: 'import { mergeLogMigration } from "./merge-log.js";' },
      { file: "products/factory/src/host.ts", line: expect.stringMatching(/^return \[.*mergeLogMigration\(29\)/) },
    ]);
  });
});
