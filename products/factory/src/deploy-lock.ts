import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "@titan-design/daemon";
import { errorCode } from "@titan-design/rpc-protocol/narrow";

export const deployLockPath = (stateDir: string): string => join(stateDir, "deploy.lock");

/** What the deploy lock reads and writes; `rename` is the one atomic step a steal relies on. */
export interface LockPorts {
  pid: number;
  readFile: (path: string) => string | undefined;
  remove: (path: string) => void;
  /** False when the file already exists. */
  createExclusive: (path: string, text: string) => boolean;
  /** False when `from` is gone, because another process moved it first. */
  rename: (from: string, to: string) => boolean;
  isAlive: (pid: number) => boolean;
}

function lockPid(ports: LockPorts, path: string): number | undefined {
  const pid = Number(ports.readFile(path)?.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Undefined when this process now holds `lock`, else why not; a lock whose pid is gone is stale and is taken over. `what` names the holder's job. */
export function takeLock(ports: LockPorts, lock: string, what = "deploy"): string | undefined {
  const mine = String(ports.pid);
  if (ports.createExclusive(lock, mine)) return undefined;
  const holder = lockPid(ports, lock);
  if (holder !== undefined && ports.isAlive(holder)) return `another ${what} is running (pid ${holder} holds ${lock})`;
  return stealStale(ports, lock, holder, what) ?? (ports.createExclusive(lock, mine) ? undefined : `another ${what} took ${lock} first`);
}

/** Only one stealer's rename succeeds; one that moved a fresh lock instead of the stale one puts it back and stands down. */
function stealStale(ports: LockPorts, lock: string, stale: number | undefined, what: string): string | undefined {
  const claimed = `${lock}.${ports.pid}.stale`;
  if (!ports.rename(lock, claimed)) return `another ${what} took ${lock} first`;
  const moved = lockPid(ports, claimed);
  ports.remove(claimed);
  if (moved === stale) return undefined;
  if (moved !== undefined) ports.createExclusive(lock, String(moved));
  return `another ${what} took ${lock} first`;
}

/** Removes `lock` only while it still names this process, so a lock another deployer took over survives. */
export function releaseLock(ports: LockPorts, lock: string): void {
  if (lockPid(ports, lock) === ports.pid) ports.remove(lock);
}

/** Read without taking the lock, since a manual hold must be settable while a deployer runs. */
export function runningDeployer(ports: Pick<LockPorts, "readFile" | "isAlive">, stateDir: string): number | undefined {
  const pid = Number(ports.readFile(deployLockPath(stateDir))?.trim());
  return Number.isInteger(pid) && pid > 0 && ports.isAlive(pid) ? pid : undefined;
}

function createExclusive(path: string, text: string): boolean {
  try {
    writeFileSync(path, text, { flag: "wx" });
    return true;
  } catch (err) {
    if (errorCode(err) === "EEXIST") return false;
    throw err;
  }
}

function rename(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** What `takeLock` needs, on the real filesystem and process table. */
export function systemLockPorts(): LockPorts {
  return { pid: process.pid, readFile: readIfPresent, remove: (path) => rmSync(path, { force: true }), createExclusive, rename, isAlive: isProcessAlive };
}
