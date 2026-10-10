import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXIT } from "@titan-design/registry";
import { openDatabase, type Db } from "@titan-design/store-sqlite";

/** sysexits' EX_TEMPFAIL: another run holds the lock, so this one did nothing and the next tick retries. */
export const EXIT_LOCKED = 75;

export interface GraphRefreshOptions {
  dbPath: string;
  lockPath: string;
  /** The graph owner's own refresh. It must be incremental and write the graph only through SQLite transactions. */
  refresh: () => Promise<void>;
  log: (line: string) => void;
}

export interface GraphHealth {
  quickCheck: string;
  sessions: number;
  newestSessionAt: string | null;
}

export type GraphRefreshResult =
  | { outcome: "locked"; holderPid: number | null; exitCode: typeof EXIT_LOCKED }
  | { outcome: "refresh-failed" | "corrupt" | "ok"; error?: string; health?: GraphHealth; exitCode: number };

interface LockHolder {
  pid: number;
  startedAt: string;
}

/**
 * One scheduled pass over a graph: take the lock without waiting, run the owner's refresh, then
 * prove the file is whole with a read-only `quick_check`. The refresh never writes outside SQLite's
 * own transactions, so a pass killed mid-write rolls back on the next open and the old rows stay.
 */
export async function runGraphRefresh(options: GraphRefreshOptions): Promise<GraphRefreshResult> {
  const holder = tryLock(options.lockPath);
  if (holder !== "acquired") {
    options.log(`graph-refresh: another run holds ${options.lockPath} (pid ${holder?.pid ?? "unknown"}); exiting`);
    return { outcome: "locked", holderPid: holder?.pid ?? null, exitCode: EXIT_LOCKED };
  }
  try {
    return await refreshThenCheck(options);
  } finally {
    rmSync(options.lockPath, { force: true });
  }
}

async function refreshThenCheck(options: GraphRefreshOptions): Promise<GraphRefreshResult> {
  let refreshError: string | undefined;
  try {
    await options.refresh();
  } catch (err) {
    refreshError = err instanceof Error ? err.message : String(err);
    options.log(`graph-refresh: FAILED: refresh: ${refreshError}`);
  }
  const health = checkGraph(options.dbPath);
  if (health.quickCheck !== "ok") {
    options.log(`graph-refresh: FAILED: ${options.dbPath} failed quick_check: ${health.quickCheck}`);
    return { outcome: "corrupt", error: health.quickCheck, health, exitCode: EXIT.SOFTWARE };
  }
  options.log(`graph-refresh: quick_check ok; ${health.sessions} sessions, newest started ${health.newestSessionAt ?? "never"}`);
  if (refreshError !== undefined) return { outcome: "refresh-failed", error: refreshError, health, exitCode: EXIT.SOFTWARE };
  return { outcome: "ok", health, exitCode: EXIT.OK };
}

/**
 * Read-only, so the check can never be the thing that tears the file. A plain SQLite open rather than
 * `openSessionGraph`, because the owner's graph may sit at an older session-graph migration than this
 * runtime knows, and that is not damage.
 */
export function checkGraph(dbPath: string): GraphHealth {
  let db: Db | undefined;
  try {
    db = openDatabase(dbPath, { readonly: true });
    const rows = db.pragma("quick_check") as { quick_check: string }[];
    const quickCheck = rows.map((r) => r.quick_check).join("; ");
    const newest = db.prepare("SELECT count(*) AS n, max(started_at) AS newest FROM session").get() as { n: number; newest: string | null };
    return { quickCheck, sessions: newest.n, newestSessionAt: newest.newest };
  } catch (err) {
    return { quickCheck: err instanceof Error ? err.message : String(err), sessions: 0, newestSessionAt: null };
  } finally {
    db?.close();
  }
}

/** An exclusive-create lock file naming its holder; a holder whose pid is gone was killed, so its lock is taken over. */
function tryLock(lockPath: string): "acquired" | LockHolder | null {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
      return "acquired";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = readHolder(lockPath);
    if (holder && isRunning(holder.pid)) return holder;
    rmSync(lockPath, { force: true });
  }
  return readHolder(lockPath);
}

function readHolder(lockPath: string): LockHolder | null {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockHolder;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Runs the owner's refresh command with inherited stdio, so its output lands in the same journal. */
export function spawnRefresh(argv: readonly string[]): () => Promise<void> {
  const [command, ...args] = argv;
  if (!command) throw new Error("graph-refresh needs the refresh command after --");
  return () =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`${argv.join(" ")} exited ${signal ?? code}`));
      });
    });
}
