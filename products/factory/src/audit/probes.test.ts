import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryStore, queryStore } from "./probes.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const signal = new AbortController().signal;

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-probes-"));
  dirs.push(dir);
  return dir;
}

function ledger(): string {
  const path = join(scratch(), "ledger.sqlite3");
  const db = openDatabase(path);
  db.exec("create table workflow_run (id text, status text, step_results text)");
  const steps = (...ids: string[]) => JSON.stringify(Object.fromEntries(ids.map((id) => [id, { stepId: id }])));
  db.prepare("insert into workflow_run values (?, ?, ?)").run("r1", "completed", steps("land-rules:0", "ci-wait:0:0", "ci-wait:0:1"));
  db.prepare("insert into workflow_run values (?, ?, ?)").run("r2", "failed", steps("merge:0"));
  db.close();
  return path;
}

describe("inventoryStore", () => {
  it("lists a sqlite store's tables, row counts and the step families inside its JSON columns", async () => {
    const inventory = await inventoryStore({ id: "ledger", kind: "sqlite", path: ledger(), readonly: true }, signal);

    expect(inventory.tables).toEqual([
      { name: "workflow_run", columns: ["id", "status", "step_results"], rows: 2, jsonKeys: { step_results: ["ci-wait", "land-rules", "merge"] } },
    ]);
  });

  it("classes log lines with counts and flags a log that carries no timestamps", async () => {
    const path = join(scratch(), "serve.err.log");
    writeFileSync(path, "daemon started pid 41\ndaemon started pid 977\n[warn] removing stale daemon pid file\n");

    const inventory = await inventoryStore({ id: "serve-log", kind: "log", path, readonly: true }, signal);

    expect(inventory.timestamped).toBe(false);
    expect(inventory.logClasses).toEqual([
      { text: "daemon started pid #", count: 2 },
      { text: "[warn] removing stale daemon pid file", count: 1 },
    ]);
  });

  it("records an unreadable store as an error instead of failing the inventory", async () => {
    const inventory = await inventoryStore({ id: "gone", kind: "log", path: join(scratch(), "absent.log"), readonly: true }, signal);

    expect(inventory).toMatchObject({ store: "gone", error: expect.stringContaining("ENOENT") });
  });
});

describe("queryStore", () => {
  it("reads a sql value and its n from a read-only connection", async () => {
    const store = { id: "ledger", kind: "sqlite" as const, path: ledger(), readonly: true as const };

    await expect(queryStore(store, { kind: "sql", store: "ledger", text: "select count(*) as value, count(*) as n from workflow_run where status = 'failed'" }, signal)).resolves.toEqual({ value: 1, n: 1 });
    await expect(queryStore(store, { kind: "sql", store: "ledger", text: "delete from workflow_run returning id" }, signal)).rejects.toThrow(/readonly/);
  });

  it("refuses a cli query outside the store's declared command", async () => {
    const store = { id: "cli", kind: "cli" as const, command: "titan-factory shepherd stats", readonly: true as const };

    await expect(queryStore(store, { kind: "cli", store: "cli", text: "rm -rf /tmp/x" }, signal)).rejects.toThrow(/outside the store's declared command/);
  });
});
