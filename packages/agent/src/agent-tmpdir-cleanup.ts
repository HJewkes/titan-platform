import type { LaunchRow } from "./launch-identity.js";
import { errnoCode, finishedIds, isLauncherOf } from "./orphan-reap.js";
import {
  AGENT_TMP_PREFIX,
  agentTmpPath,
  currentUid,
  isTmpRoot,
  realTmpFs,
  realTmpProcessTable,
  removeAgentTmpDir,
  TMP_ROOT,
  type RemovalDeps,
  type RemovalTarget,
  type TmpProcessTable,
  type TmpRemoval,
} from "./agent-tmpdir.js";

/** CC-901: removing a launch's TMPDIR, at its own exit and in the broker's periodic sweep of finished launches. */

type Log = (event: string, detail: Record<string, unknown>) => void;

/**
 * `removeAgentTmpDir` that reports a throw instead of raising it. A tree with a 0555 subdir makes
 * rm throw EACCES part-way; uncaught, that is a stack trace at run-agent exit and, in the sweep,
 * one undeletable dir ending every later pass before the entries after it.
 */
function tryRemove(target: RemovalTarget, deps: RemovalDeps): TmpRemoval {
  try {
    return removeAgentTmpDir(target, deps);
  } catch (err) {
    return {
      removed: false,
      path: agentTmpPath(target.name, target.pid, target.root) ?? "",
      reason: err instanceof Error ? err.message : String(err),
      code: errnoCode(err) ?? "unknown",
    };
  }
}

function logRemoval(log: Log, source: "exit" | "sweep", agentId: string, result: TmpRemoval): void {
  if (result.removed) {
    log("tmpdir_removed", { source, agentId, path: result.path, inodes: result.inodes });
  } else if (result.code !== undefined) {
    log("tmpdir_remove_failed", {
      source,
      agentId,
      path: result.path,
      code: result.code,
      reason: result.reason,
    });
  } else if (result.reason !== "missing") {
    log("tmpdir_kept", { source, agentId, path: result.path, reason: result.reason });
  }
}

export interface ExitTmpDeps extends RemovalDeps {
  platform: NodeJS.Platform;
  log: Log;
}

export const realExitTmpDeps = (log: Log): ExitTmpDeps => ({
  fs: realTmpFs,
  table: realTmpProcessTable(),
  uid: currentUid(),
  self: process.pid,
  platform: process.platform,
  log,
});

/** Run by `run-agent` as it exits, after the orphan reap: removes its own launch's dir under `root`. */
export function removeOwnTmpDir(
  name: string,
  agentId: string,
  launcherPid: number,
  deps: ExitTmpDeps,
  root = TMP_ROOT
): void {
  if (deps.platform !== "linux") return;
  const result = tryRemove({ name, pid: launcherPid, agentIds: new Set([agentId]), root }, deps);
  logRemoval(deps.log, "exit", agentId, result);
}

export interface TmpSweepDeps extends RemovalDeps {
  roster: () => readonly LaunchRow[];
  now: () => number;
  log: Log;
  /** Paths already reported as kept, so a standing refusal is logged once rather than every sweep. */
  announced?: Set<string>;
  /** The roots to scan; defaults to /tmp alone. A root that does not exist is skipped. */
  roots?: readonly string[];
}

/** Finished names mapped to their agent ids; a name that also has a live row is left out entirely. */
function finishedNames(roster: readonly LaunchRow[], now: number): Map<string, Set<string>> {
  const finished = finishedIds(roster, now);
  const live = new Set(roster.filter(a => !finished.has(a.agentId)).map(a => a.name));
  const names = new Map<string, Set<string>>();
  for (const a of roster) {
    if (!finished.has(a.agentId) || live.has(a.name)) continue;
    names.set(a.name, (names.get(a.name) ?? new Set()).add(a.agentId));
  }
  return names;
}

/** The launcher pid of `entry` when it is exactly `ac-<name>-<pid>` for this name. */
function pidOf(entry: string, name: string, root: string): number | undefined {
  const prefix = `${AGENT_TMP_PREFIX}${name}-`;
  if (!entry.startsWith(prefix)) return undefined;
  const digits = entry.slice(prefix.length);
  if (!/^[1-9]\d{0,9}$/.test(digits)) return undefined;
  const pid = Number(digits);
  return agentTmpPath(name, pid, root) === `${root}/${entry}` ? pid : undefined;
}

function sweepOne(target: RemovalTarget, deps: TmpSweepDeps): void {
  // The launcher itself does not carry the launch identity, so a still-running one is checked by argv.
  const command = deps.table.command(target.pid);
  if (deps.table.isAlive(target.pid) && [...target.agentIds].some(id => isLauncherOf(command, id))) return;
  const result = tryRemove(target, deps);
  if (!result.removed && deps.announced?.has(result.path)) return;
  if (!result.removed) deps.announced?.add(result.path);
  logRemoval(deps.log, "sweep", [...target.agentIds].join(","), result);
}

function memoized<T>(read: (pid: number) => T): (pid: number) => T {
  const seen = new Map<number, { value: T }>();
  return pid => {
    let hit = seen.get(pid);
    if (hit === undefined) {
      hit = { value: read(pid) };
      seen.set(pid, hit);
    }
    return hit.value;
  };
}

/**
 * CC-1447: each /proc entry read at most once per sweep pass. `holder` scans every process for
 * every kept dir, so with ~770 dirs and ~2,400 processes an unshared table re-read /proc for
 * minutes, synchronously, and the broker stopped answering frames.
 */
export function passSnapshot(table: TmpProcessTable): TmpProcessTable {
  let pids: number[] | undefined;
  return {
    pids: () => (pids ??= table.pids()),
    environ: memoized(pid => table.environ(pid)),
    command: memoized(pid => table.command(pid)),
    parentOf: memoized(pid => table.parentOf(pid)),
    isAlive: memoized(pid => table.isAlive(pid)),
    cwd: memoized(pid => table.cwd(pid)),
    fds: memoized(pid => table.fds(pid)),
  };
}

/** One pass: removes the dirs of agents whose rows are finished, for launches that left one behind. */
export function sweepAgentTmpDirs(deps: TmpSweepDeps): void {
  const names = finishedNames(deps.roster(), deps.now());
  if (names.size === 0) return;
  const pass = { ...deps, table: passSnapshot(deps.table) };
  for (const root of deps.roots ?? [TMP_ROOT]) {
    if (isTmpRoot(root) && deps.fs.lstat(root) !== undefined) sweepRoot(root, names, pass);
  }
}

function sweepRoot(root: string, names: Map<string, Set<string>>, deps: TmpSweepDeps): void {
  for (const entry of deps.fs.readdir(root)) {
    if (!entry.startsWith(AGENT_TMP_PREFIX)) continue;
    for (const [name, agentIds] of names) {
      const pid = pidOf(entry, name, root);
      if (pid !== undefined) sweepOne({ name, pid, agentIds, root }, deps);
    }
  }
}
