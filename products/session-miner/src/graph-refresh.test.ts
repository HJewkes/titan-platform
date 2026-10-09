import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { checkGraph, EXIT_LOCKED, runGraphRefresh, spawnRefresh } from "./graph-refresh.js";

const transcript = (sessionId: string) =>
  [
    { type: "user", sessionId, cwd: "/tmp", uuid: `${sessionId}-p`, timestamp: "2026-07-01T00:00:01Z", message: { role: "user", content: `hello from ${sessionId}` } },
    { type: "assistant", sessionId, cwd: "/tmp", timestamp: "2026-07-01T00:00:02Z", message: { role: "assistant", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "hi" }] } },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n") + "\n";

const PRODUCT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let dir: string;
let corpus: string;
let state: string;
let dbPath: string;
let lockPath: string;
const logs: string[] = [];
const log = (line: string) => logs.push(line);

/** The miner's own incremental refresh, so the runner is exercised against session-graph's real watermarks. */
async function minerRefresh(): Promise<{ indexed: number; unchanged: number }> {
  let out = "";
  const code = await runCli(["--json", "--state", state, "--corpus", corpus, "refresh"], { stdout: (t) => (out += t), stderr: () => {}, env: {} });
  if (code !== 0) throw new Error(`miner refresh exited ${code}`);
  return (JSON.parse(out) as { data: { indexed: number; unchanged: number } }).data;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-miner-graph-refresh-"));
  corpus = path.join(dir, "corpus");
  state = path.join(dir, "state");
  dbPath = path.join(state, "index.sqlite3");
  lockPath = path.join(state, "graph-refresh.lock");
  mkdirSync(path.join(corpus, "proj"), { recursive: true });
  writeFileSync(path.join(corpus, "proj", "s1.jsonl"), transcript("s1"));
  logs.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("graph-refresh", () => {
  it("indexes only the new transcript on a second scheduled run and reports the graph whole", async () => {
    const summaries: { indexed: number; unchanged: number }[] = [];
    const refresh = async () => void summaries.push(await minerRefresh());

    const first = await runGraphRefresh({ dbPath, lockPath, refresh, log });
    writeFileSync(path.join(corpus, "proj", "s2.jsonl"), transcript("s2"));
    const second = await runGraphRefresh({ dbPath, lockPath, refresh, log });

    expect(first).toMatchObject({ outcome: "ok", exitCode: 0, health: { quickCheck: "ok", sessions: 1 } });
    expect(second).toMatchObject({ outcome: "ok", exitCode: 0, health: { quickCheck: "ok", sessions: 2 } });
    expect(summaries[1]).toMatchObject({ indexed: 1, unchanged: 1 });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("exits on the lock without refreshing while another run holds it", async () => {
    let release!: () => void;
    const holding = runGraphRefresh({ dbPath, lockPath, refresh: () => new Promise<void>((r) => (release = r)), log });
    let secondRefreshed = false;

    const second = await runGraphRefresh({ dbPath, lockPath, refresh: async () => void (secondRefreshed = true), log });
    release();
    await holding;

    expect(second).toEqual({ outcome: "locked", holderPid: process.pid, exitCode: EXIT_LOCKED });
    expect(secondRefreshed).toBe(false);
    expect(logs.some((line) => line.includes("another run holds"))).toBe(true);
  });

  it("takes over a lock left by a run that was killed", async () => {
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    mkdirSync(state, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, startedAt: "2026-10-08T00:00:00Z" }));

    const result = await runGraphRefresh({ dbPath, lockPath, refresh: async () => void (await minerRefresh()), log });

    expect(result).toMatchObject({ outcome: "ok", health: { sessions: 1 } });
  });

  it("leaves the old graph intact and fails loudly when the refresh is killed mid-write", async () => {
    await minerRefresh();
    const marker = path.join(dir, "child.pid");
    const storeUrl = pathToFileURL(path.join(PRODUCT_DIR, "node_modules", "@titan-design", "store-sqlite", "dist", "index.js")).href;
    const script = `const { openDatabase } = await import(${JSON.stringify(storeUrl)});
      const db = openDatabase(${JSON.stringify(dbPath)});
      db.exec("BEGIN"); db.exec("DELETE FROM session");
      (await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, String(process.pid));
      setInterval(() => {}, 1000);`;
    const killWhenWriting = async () => {
      while (!existsSync(marker)) await sleep(20);
      process.kill(Number(readFileSync(marker, "utf8")), "SIGKILL");
    };

    const [result] = await Promise.all([
      runGraphRefresh({ dbPath, lockPath, refresh: spawnRefresh([process.execPath, "--input-type=module", "-e", script]), log }),
      killWhenWriting(),
    ]);

    expect(result).toMatchObject({ outcome: "refresh-failed", exitCode: 70, health: { quickCheck: "ok", sessions: 1 } });
    expect(logs.some((line) => line.includes("FAILED: refresh"))).toBe(true);
    expect(checkGraph(dbPath).sessions).toBe(1);
  });

  it("refuses an empty --graph rather than checking the miner's own index", async () => {
    let err = "";

    const code = await runCli(["--state", state, "--graph", "", "graph-refresh", "--", "true"], { stdout: () => {}, stderr: (t) => (err += t), env: {} });

    expect(code).toBe(64);
    expect(err).toContain("--graph is empty");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("reports a file that is not a database as corrupt", async () => {
    mkdirSync(state, { recursive: true });
    writeFileSync(dbPath, "not a sqlite file, just some torn bytes ".repeat(200));

    const result = await runGraphRefresh({ dbPath, lockPath, refresh: async () => {}, log });

    expect(result).toMatchObject({ outcome: "corrupt", exitCode: 70 });
    expect(logs.some((line) => line.includes("failed quick_check"))).toBe(true);
  });
});
