import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { openFactoryHost } from "./host.js";
import { ShepherdStore } from "./shepherd/store.js";
import { factoryRoutes, factoryWorkflows } from "./workflows.js";

const HOUR = 3_600_000;
const END = "2026-10-09T06:00:00.000Z";
const AT = "2026-10-08T12:00:00.000Z";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capture(env: NodeJS.ProcessEnv = {}): { out: string[]; err: string[]; io: Parameters<typeof runCli>[1] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env } };
}

function mergedRun(id: string): WorkflowRun {
  const stepResults: WorkflowRun["stepResults"] = { "merge:0": { stepId: "merge:0", iteration: 0, agentId: null, signal: null, completedAt: AT, data: { result: { done: true } } } };
  return { id, workflowName: "shepherd-pr", params: {}, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: AT, completedAt: AT, error: null };
}

/** A ledger where PRs 1..`shepherd` of acme/widgets merged through Shepherd. */
function ledger(dir: string, shepherd: number): string {
  const dbPath = join(dir, "factory.db");
  openFactoryHost({ dbPath, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
  const db = openDatabase(dbPath);
  for (let pr = 1; pr <= shepherd; pr++) {
    new WorkflowRunStore(db).create(mergedRun(`r${pr}`));
    new ShepherdStore(db).register({ repo: "acme/widgets", pr, runId: `r${pr}`, task: "T/X-1", implementer: "impl", policy: { merge: "auto", mergeMethod: "squash", fixer: false, seat: "titan-coord" } });
  }
  db.close();
  return dbPath;
}

function mergedLines(prs: readonly number[], ts: string = AT): string {
  return prs.map((pr) => `${JSON.stringify({ ts, pr, outcome: "merged", note: "merged" })}\n`).join("");
}

/** A config naming a seat book (titan-coord owns acme/widgets) whose `logs` sibling holds titan-coord's dispatch log. */
function fixture(shepherd: number, merged: readonly number[], ts?: string): { dbPath: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "coverage-cli-"));
  dirs.push(dir);
  mkdirSync(join(dir, "seats"));
  writeFileSync(join(dir, "seats", "titan-coord.md"), "---\nschema: autonomy-seat/v1\nname: titan-coord\nrepos:\n  - {path: ~/src/widgets, remote: acme/widgets}\ngrants_extra: []\n---\n");
  mkdirSync(join(dir, "logs", "titan-coord"), { recursive: true });
  writeFileSync(join(dir, "logs", "titan-coord", "dispatch.jsonl"), mergedLines(merged, ts));
  mkdirSync(join(dir, "config", "titan-factory"), { recursive: true });
  writeFileSync(join(dir, "config", "titan-factory", "config.json"), JSON.stringify({ shepherd: { seatsDir: join(dir, "seats") } }));
  return { dbPath: ledger(dir, shepherd), env: { XDG_CONFIG_HOME: join(dir, "config") } };
}

async function coverage(f: { dbPath: string; env: NodeJS.ProcessEnv }, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const { out, err, io } = capture(f.env);
  const code = await runCli(["--db", f.dbPath, "shepherd", "coverage", ...args], io);
  return { code, out: out.join(""), err: err.join("") };
}

describe("shepherd coverage verb", () => {
  it("prints the report as JSON, with bare PR numbers resolved through the seat book", async () => {
    const f = fixture(7, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const { code, out } = await coverage(f, "--end", END, "--json");

    expect(code).toBe(0);
    const report = JSON.parse(out);
    expect(Object.keys(report)).toEqual(["window", "seats", "total", "misses", "untypedHolds", "skipped"]);
    expect(report.window).toEqual({ start: Date.parse(END) - 24 * HOUR, end: Date.parse(END) });
    expect(report.seats.map((s: { seat: string }) => s.seat)).toEqual(["titan-coord", "design-coord", "voltras-coord", "platform-coord"]);
    expect(report.total).toEqual({ merged: 10, excluded: 0, shepherd: 7, share: 0.7 });
  });

  it("exits 1 when the total share is below --min", async () => {
    const f = fixture(7, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const { code, out } = await coverage(f, "--end", END, "--min", "0.8");

    expect(code).toBe(1);
    expect(out).toContain("total  merged 10  excluded 0  shepherd 7  share 70%");
  });

  it("exits 0 when the total share meets --min", async () => {
    const f = fixture(8, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const { code } = await coverage(f, "--end", END, "--min", "0.8");

    expect(code).toBe(0);
  });

  it("exits 1 under --min when the window has no counted merge", async () => {
    const f = fixture(0, []);

    const { code, out } = await coverage(f, "--end", END, "--min", "0.8");

    expect(code).toBe(1);
    expect(out).toContain("total  merged 0  excluded 0  shepherd 0  share n/a");
  });

  it("prints one line per seat, the total, then the misses", async () => {
    const f = fixture(1, [1, 2]);

    const { code, out } = await coverage(f, "--end", END, "--seat", "titan-coord");

    expect(code).toBe(0);
    expect(out.split("\n").slice(1)).toEqual([
      "titan-coord  merged 2  excluded 0  shepherd 1  share 50%",
      "total  merged 2  excluded 0  shepherd 1  share 50%",
      "",
      "misses:",
      "  titan-coord  2  merged  (unresolved)",
      "",
    ]);
  });

  it("defaults to the 24 hours ending now", async () => {
    const f = fixture(1, [1]);
    const dir = join(f.env.XDG_CONFIG_HOME!, "..");
    writeFileSync(join(dir, "logs", "titan-coord", "dispatch.jsonl"), mergedLines([1], new Date(Date.now() - HOUR).toISOString()) + mergedLines([2], new Date(Date.now() - 25 * HOUR).toISOString()));

    const { code, out } = await coverage(f, "--json");

    expect(code).toBe(0);
    const report = JSON.parse(out);
    expect(report.window.end - report.window.start).toBe(24 * HOUR);
    expect(Math.abs(report.window.end - Date.now())).toBeLessThan(60_000);
    expect(report.total).toEqual({ merged: 1, excluded: 0, shepherd: 1, share: 1 });
  });

  it("reads --logs in place of the seat book's logs directory", async () => {
    const f = fixture(1, []);
    const logs = join(f.env.XDG_CONFIG_HOME!, "..", "other-logs");
    mkdirSync(join(logs, "titan-coord"), { recursive: true });
    writeFileSync(join(logs, "titan-coord", "dispatch.jsonl"), mergedLines([1]));

    const { out } = await coverage(f, "--end", END, "--logs", logs, "--json");

    expect(JSON.parse(out).total.merged).toBe(1);
  });

  it("reads a store it cannot write", async () => {
    const f = fixture(1, [1]);
    chmodSync(f.dbPath, 0o444);

    const { code } = await coverage(f, "--end", END, "--json");

    expect(code).toBe(0);
    const db = openDatabase(f.dbPath);
    expect(() => db.exec("DELETE FROM shepherd_registration")).toThrow(/readonly/);
    db.close();
  });

  it("exits 2 with the path when the store cannot be read", async () => {
    const f = fixture(0, []);
    const missing = join(f.env.XDG_CONFIG_HOME!, "absent", "factory.db");

    const { code, err } = await coverage({ ...f, dbPath: missing }, "--end", END);

    expect(code).toBe(2);
    expect(err).toContain(missing);
  });

  it.each([
    ["an --end that is not a time", ["--end", "yesterday"]],
    ["a --min above 1", ["--min", "80"]],
    ["a --hours of 0", ["--hours", "0"]],
  ])("exits 2 for %s", async (_name, args) => {
    const f = fixture(0, []);

    const { code, err } = await coverage(f, ...args);

    expect(code).toBe(2);
    expect(err).toMatch(/^error: /);
  });
});
