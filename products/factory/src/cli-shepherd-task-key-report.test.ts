import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, runCli } from "./cli.js";
import { taskIndexFetch } from "./test-support/task-index.js";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "task-key-report-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Only the columns the report reads; the registrations are synthetic. */
function store(tasks: readonly string[]): string {
  const path = join(dir, "factory.sqlite3");
  const db = new DatabaseSync(path);
  db.exec("create table shepherd_registration (run_id text not null unique, task text not null, created_at text not null)");
  const insert = db.prepare("insert into shepherd_registration values (?, ?, ?)");
  tasks.forEach((task, n) => insert.run(`run-${n}`, task, `2026-11-0${n + 1}T00:00:00Z`));
  db.close();
  return path;
}

const INDEX = taskIndexFetch(
  [{ id: "T-1", slug: "demo" }, { id: "S-1", slug: "private-lane" }],
  [{ slug: "demo", task_prefix: "T" }, { slug: "private-lane", task_prefix: "S", withheld_from_agents: true }],
);

async function report(dbPath: string, fetch = INDEX) {
  const out = { stdout: "", stderr: "" };
  const io = { stdout: (t: string) => void (out.stdout += t), stderr: (t: string) => void (out.stderr += t), env: {} };
  const code = await runCli(["--db", dbPath, "shepherd", "task-key-report", "--json"], io, { workflows: [], routes: [], fetch });
  return { code, ...out };
}

describe("shepherd task-key-report", () => {
  it("lists each non-canonical key with its proposed mapping or no match, and counts them", async () => {
    const dbPath = store(["demo/T-1", "T-1", "seat-x/T-1", "demo/T-99", "S-1"]);

    const { code, stdout } = await report(dbPath);

    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(stdout)).toEqual({
      total: 5,
      resolved: 1,
      proposed: 3,
      noMatch: 1,
      ownerOnly: 1,
      rows: [
        { runId: "run-1", task: "T-1", reason: "bare", proposed: "demo/T-1" },
        { runId: "run-2", task: "seat-x/T-1", reason: "wrong-initiative", proposed: "demo/T-1" },
        { runId: "run-3", task: "demo/T-99", reason: "not-found", proposed: null },
        { runId: "run-4", task: "S-1", reason: "bare", proposed: "<owner-only>/S-1" },
      ],
    });
  });

  it("writes nothing: the store's bytes and files are unchanged", async () => {
    const dbPath = store(["seat-x/T-1"]);
    const before = readFileSync(dbPath);

    await report(dbPath);

    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(["factory.sqlite3"]);
  });

  it("creates no store at a missing path", async () => {
    const { code } = await report(join(dir, "absent.sqlite3"));

    expect(code).toBe(EXIT.USAGE);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("exits 69 when the task index cannot be read", async () => {
    const down = (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;

    const { code } = await report(store(["T-1"]), down);

    expect(code).toBe(EXIT.UNAVAILABLE);
  });
});
