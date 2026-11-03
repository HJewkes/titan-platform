import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { runCli } from "../cli.js";
import { shadowLogMigration } from "./shadow-diff/log.js";


const MANIFEST = z.object({
  defaults: z.array(z.object({ path: z.string(), task: z.string().optional(), milestone: z.string().optional(), fate: z.string() })),
  entries: z.array(z.object({ path: z.string(), task: z.string().optional() })),
});
const HOUR = 3_600_000;
const FAMILIES = ["tree", "diff", "observed"];
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "markers-command-"));
  path = join(dir, "factory.db");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function insert(db: Db, hoursAgo: number, fields: { kind?: string; family?: string | null; class?: string | null; cause?: string | null; runId?: string; memoKey?: string }): void {
  const at = new Date(Date.now() - hoursAgo * HOUR).toISOString();
  db.prepare("INSERT INTO factory_shadow_log (at, kind, family, run_id, memo_key, class, cause) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(at, fields.kind ?? "compare", fields.family ?? null, fields.runId ?? "run-1", fields.memoKey ?? null, fields.class ?? null, fields.cause ?? null);
}

/** A rollback-journal file, so a read-write open would flip it to WAL and change its bytes. */
function seed(rows: (db: Db) => void): void {
  const db = openDatabase(path, { wal: false });
  runMigrations(db, [shadowLogMigration()]);
  insert(db, 60, { kind: "entry-end" });
  FAMILIES.forEach((family, index) => {
    insert(db, 10, { family, class: "hit", runId: `hit-${index}`, memoKey: `hit-${index}` });
    insert(db, 9, { family, class: "miss", runId: `miss-${index}`, memoKey: `miss-${index}` });
  });
  rows(db);
  db.close();
}

async function run(...argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runCli(["--db", path, "markers", ...argv], { stdout: (text) => (out += text), stderr: () => undefined, env: {} });
  return { code, out };
}

const snapshot = (): string => createHash("sha1").update(readFileSync(path)).digest("hex");

describe("markers shadow-diff and shadow-gate", () => {
  it("markers shadow-diff --json prints per-family counts with causes", async () => {
    seed((db) => insert(db, 5, { family: "diff", class: "pin-differs", cause: "whitespace", runId: "carry", memoKey: "carry:1" }));

    const { code, out } = await run("shadow-diff", "--since", "48h", "--json");

    expect(code).toBe(0);
    expect(JSON.parse(out).counts.diff).toEqual({ classes: { hit: 1, miss: 1, "pin-differs": 1 }, causes: { whitespace: 1 }, materialOnly: 0 });
  });

  it("markers shadow-gate exits 1 on an unclassified row and 0 on a clean 48 h log", async () => {
    seed(() => undefined);
    const clean = await run("shadow-gate");
    const db = openDatabase(path);
    insert(db, 5, { family: "diff", class: "pin-differs", cause: "unclassified", runId: "carry", memoKey: "carry:2" });
    db.close();

    const blocked = await run("shadow-gate", "--json");

    expect({ clean: clean.code, blocked: blocked.code }).toEqual({ clean: 0, blocked: 1 });
    expect(JSON.parse(blocked.out).reasons).toEqual([expect.stringContaining("run carry")]);
  });

  it("running shadow-gate leaves the database byte-equal", async () => {
    seed((db) => insert(db, 5, { family: "tree", class: "false-hit", runId: "bad", memoKey: "bad:1" }));
    const before = snapshot();

    const { code } = await run("shadow-gate");

    expect(code).toBe(1);
    expect(snapshot()).toBe(before);
  });

  it("the sunset check maps every shadow-diff file to D-M8-09", () => {
    const manifest = MANIFEST.parse(JSON.parse(readFileSync(join(import.meta.dirname, "../../sunset/manifest.json"), "utf8")));
    const root = "products/factory/src/markers/shadow-diff";
    const files = readdirSync(join(import.meta.dirname, "shadow-diff")).map((name) => `${root}/${name}`);

    const unmapped = files.filter((file) => manifest.entries.find((entry) => entry.path === file)?.task !== "D-M8-09");

    expect(unmapped).toEqual([]);
    expect(manifest.defaults.find((rule) => rule.path === root)).toMatchObject({ fate: "delete", task: "D-M8-09", milestone: "M8" });
  });
});
