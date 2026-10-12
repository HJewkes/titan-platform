/** What the fence reads and does to the service manager; tests pass a fake MainPID sequence and a fake clock. */
export interface RestartFencePorts {
  /** The unit's MainPID, or undefined while it has no main process. */
  readMainPid: () => Promise<number | undefined>;
  /** Queues the restart without waiting for the stop; resolves the failure text, or undefined once queued. */
  requestRestart: () => Promise<string | undefined>;
  /** SIGKILLs every process the service manager holds for the unit; resolves the failure text, or undefined. */
  killUnit: () => Promise<string | undefined>;
  /** How the kill reads in the fence line, e.g. `systemctl kill`. */
  killVia: string;
  /** The unit or job name the fence line names. */
  unit: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

type FenceOutcome = { ok: true; pid: number; fenced?: number } | { ok: false; why: string };

/**
 * Above the slowest clean stop seen (27 s) and below systemd's 90 s default, which outlasts the
 * deployer's 30 s command cap; a serve whose event loop is blocked never runs its SIGTERM handler.
 */
export const STOP_FENCE_MS = 45_000;
export const KILL_SETTLE_MS = 10_000;
const FENCE_POLL_MS = 250;

/** The last MainPID read; `fresh` once it is a main process other than `oldPid`. */
type PidWait = { fresh: true; pid: number } | { fresh: false; pid: number | undefined };

/** A poll loop ends on the clock, or on the poll count when a fake clock never moves, whichever comes first. */
async function awaitNewPid(ports: RestartFencePorts, oldPid: number | undefined, budgetMs: number): Promise<PidWait> {
  const startedAt = ports.now();
  let pid: number | undefined;
  for (let poll = 0; poll * FENCE_POLL_MS < budgetMs; poll++) {
    pid = await ports.readMainPid();
    if (pid !== undefined && pid !== oldPid) return { pid, fresh: true };
    if (ports.now() - startedAt >= budgetMs) break;
    await ports.sleep(FENCE_POLL_MS);
  }
  return { pid, fresh: false };
}

const seconds = (ms: number): string => `${ms / 1000} s`;

/**
 * Restarts without blocking on the stop, then fences a main process still alive after STOP_FENCE_MS
 * through the service manager, so its own cgroup or job proves which process is killed. A new MainPID
 * proves the old one is gone, since systemd starts the new main only once the old cgroup is empty.
 */
export async function fencedRestart(ports: RestartFencePorts): Promise<FenceOutcome> {
  const oldPid = await ports.readMainPid();
  const refused = await ports.requestRestart();
  if (refused !== undefined) return { ok: false, why: refused };
  const waited = await awaitNewPid(ports, oldPid, STOP_FENCE_MS);
  if (waited.fresh) return { ok: true, pid: waited.pid };
  if (waited.pid === undefined) return { ok: false, why: `${ports.unit} started no main process within ${seconds(STOP_FENCE_MS)}` };
  return escalate(ports, waited.pid);
}

async function escalate(ports: RestartFencePorts, oldPid: number): Promise<FenceOutcome> {
  ports.log(`fenced pid ${oldPid} (${ports.unit} MainPID, alive ${seconds(STOP_FENCE_MS)} after SIGTERM): SIGKILL via ${ports.killVia}\n`);
  const killFailed = await ports.killUnit();
  if (killFailed !== undefined) return { ok: false, why: `${ports.killVia} failed on pid ${oldPid}: ${killFailed}` };
  const settled = await awaitNewPid(ports, oldPid, KILL_SETTLE_MS);
  if (settled.fresh) return { ok: true, pid: settled.pid, fenced: oldPid };
  return { ok: false, why: `pid ${oldPid} is still ${ports.unit}'s main process ${seconds(STOP_FENCE_MS + KILL_SETTLE_MS)} after the restart, SIGKILL included` };
}
