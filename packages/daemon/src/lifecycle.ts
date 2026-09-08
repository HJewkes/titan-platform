/**
 * PID-file lifecycle for a single-instance daemon.
 *
 * The pid file is the discovery handle; a companion metadata JSON carries the port,
 * version, and start time so external callers can introspect a running daemon without
 * opening an HTTP connection. Paths are supplied by the caller — this package has no
 * opinion about where a product keeps its state.
 */
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export interface DaemonPaths {
  pidFile: string;
  metaFile: string;
}

export interface DaemonMeta {
  port: number;
  version: string;
  started: string;
}

export interface PidFileContents {
  pid: number;
  meta: DaemonMeta;
}

export const DEFAULT_DAEMON_PORT = 7400;

/** The conventional layout inside a state directory: `daemon.pid` + `daemon.meta.json`. */
export function daemonPaths(stateDir: string): DaemonPaths {
  return {
    pidFile: path.join(stateDir, "daemon.pid"),
    metaFile: path.join(stateDir, "daemon.meta.json"),
  };
}

let tmpCounter = 0;

/**
 * Write `contents` to `target` so no reader can ever observe it half-written.
 *
 * `fs.writeFile` opens with `O_TRUNC` and writes as a separate syscall, so a concurrent
 * reader between the two sees an empty file, and a concurrent *writer* interleaves
 * byte-for-byte: a departing daemon's `3273` landing on a successor's `999999` yields the
 * literal `327399`. Staging in a sibling temp file and renaming makes the swap atomic.
 */
async function writeFileAtomic(target: string, contents: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${(tmpCounter++).toString(36)}.tmp`;
  try {
    await fs.writeFile(tmp, contents, "utf8");
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function writePidFile(paths: DaemonPaths, pid: number, meta: DaemonMeta): Promise<void> {
  await fs.mkdir(path.dirname(paths.pidFile), { recursive: true });
  await fs.mkdir(path.dirname(paths.metaFile), { recursive: true });
  // Meta first: the pid file is the discovery handle, so anything that finds it must also
  // find the metadata rather than the `port: 0` fallback.
  await writeFileAtomic(paths.metaFile, JSON.stringify(meta, null, 2));
  await writeFileAtomic(paths.pidFile, String(pid));
}

export async function readPidFile(paths: DaemonPaths): Promise<PidFileContents | null> {
  const pidRaw = await readIfPresent(paths.pidFile);
  if (pidRaw === null) return null;
  const pid = Number.parseInt(pidRaw.trim(), 10);
  if (!Number.isFinite(pid)) return null;

  const metaRaw = await readIfPresent(paths.metaFile);
  const meta: DaemonMeta = metaRaw ? (JSON.parse(metaRaw) as DaemonMeta) : { port: 0, version: "unknown", started: "" };
  return { pid, meta };
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Delete the pid file — but only while it still names `expectedPid`.
 *
 * Supervised restarts overlap by design: the successor binds the port and writes its own
 * pid file before the departing instance's SIGTERM handler cleans up. An unconditional
 * unlink there deletes the *successor's* file, leaving a live daemon that every status
 * command reports as absent. A mismatch means someone else owns the daemon now.
 *
 * Returns whether the file was removed.
 */
export async function removePidFile(paths: DaemonPaths, expectedPid: number): Promise<boolean> {
  const current = await readPidFile(paths);
  if (current === null || current.pid !== expectedPid) return false;
  for (const p of [paths.pidFile, paths.metaFile]) {
    try {
      await fs.unlink(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return true;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we cannot signal it.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The command name currently running at `pid` (e.g. `node`), or `null` if the pid has no
 * process or the lookup fails.
 *
 * `kill(pid, 0)` only proves *some* process holds that pid — the OS reuses pids, so a
 * recorded lease can outlive the process it named. Pair the liveness check with this
 * identity check: record the command at write time, re-read it later, and a mismatch
 * means the pid was recycled.
 */
export function getProcessCommand(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 500 }).trim() || null;
  } catch {
    return null;
  }
}

export interface ProbeHealthOptions {
  host?: string;
  timeoutMs?: number;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 500;

/** GET `/health` on a running daemon; null on any failure, so callers can treat it as "not up". */
export async function probeHealth(port: number, options: ProbeHealthOptions = {}): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${options.host ?? "127.0.0.1"}:${port}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
