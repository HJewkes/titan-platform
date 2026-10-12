/** A process listening on the port; `pid` is absent when the reader cannot see it, as `ss` hides another user's. */
export interface Listener {
  pid?: number;
}

export interface ProcessInfo {
  /** The full command line, as /proc/<pid>/cmdline or ps holds it; never comm, which reads `MainThread` for every node process. */
  argv: readonly string[];
  /** The systemd unit whose cgroup holds the process, e.g. `titan-factory.service`. */
  cgroupUnit?: string;
  /** An opaque start time; a changed value means the pid now names another process. */
  startedAt?: string;
}

/** The machine reads and the one effect the fence has; tests pass a fake process table, so no real signal is sent. */
export interface PortOwnerReaders {
  /** Undefined when the listeners cannot be read, e.g. no `ss` on PATH. */
  listeners: (port: number) => Promise<Listener[] | undefined>;
  /** Undefined once the process is gone. */
  processInfo: (pid: number) => Promise<ProcessInfo | undefined>;
  signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
}

export interface PortOwnerPorts extends PortOwnerReaders {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

/** The service the fence must leave to its own manager: the unit's cgroup on Linux, the job pid on macOS. */
export interface ManagedService {
  name: string;
  pid?: number;
}

export type ForeignFence = { ok: true } | { ok: false; why: string };

export const FOREIGN_TERM_MS = 15_000;
export const FOREIGN_KILL_MS = 5_000;
const PORT_POLL_MS = 250;

/** The deploy checkout and a source checkout both run this file; an npm install runs it under the package name. */
const SERVE_BIN_SUFFIXES = ["/products/factory/dist/bin.js", "/@titan-design/factory/dist/bin.js"];

/** True only for `<node> [node flags] <factory bin.js> serve ...`, so a holder that merely mentions serve is never signalled. */
export function isFactoryServeArgv(argv: readonly string[]): boolean {
  const bin = argv.findIndex((arg, index) => index > 0 && SERVE_BIN_SUFFIXES.some((suffix) => arg.endsWith(suffix)));
  return bin > 0 && argv[bin + 1] === "serve";
}

const isManaged = (pid: number, info: ProcessInfo, service: ManagedService): boolean => info.cgroupUnit === service.name || pid === service.pid;
const shownArgv = (argv: readonly string[]): string => argv.slice(0, 2).join(" ") || "no readable command line";
const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;

/**
 * Clears a titan-factory serve started outside the managed service off the port, so the restarted
 * service can bind it. Identity is the command line plus cgroup or job pid, re-checked by start time
 * before SIGKILL. Any other holder is refused by pid and argv, and nothing is signalled.
 */
export async function fenceForeignServe(ports: PortOwnerPorts, port: number, service: ManagedService): Promise<ForeignFence> {
  const listeners = await ports.listeners(port);
  if (listeners === undefined) {
    ports.log(`could not read the listeners on :${port}; no foreign serve was fenced\n`);
    return { ok: true };
  }
  for (const listener of listeners) {
    const fenced = await fenceListener(ports, port, service, listener);
    if (!fenced.ok) return fenced;
  }
  return { ok: true };
}

async function fenceListener(ports: PortOwnerPorts, port: number, service: ManagedService, listener: Listener): Promise<ForeignFence> {
  const { pid } = listener;
  if (pid === undefined) return { ok: false, why: `port ${port} is held by a process this user cannot see; nothing was signalled` };
  const info = await ports.processInfo(pid);
  if (info === undefined || isManaged(pid, info, service)) return { ok: true };
  if (!isFactoryServeArgv(info.argv)) {
    return { ok: false, why: `port ${port} is held by pid ${pid} (${shownArgv(info.argv)}), which is not titan-factory serve; nothing was signalled` };
  }
  if (info.startedAt === undefined) return { ok: false, why: `port ${port} is held by titan-factory serve pid ${pid}, whose start time is unreadable, so pid reuse cannot be ruled out; nothing was signalled` };
  return terminate(ports, `fenced pid ${pid} (titan-factory serve outside ${service.name}, held :${port})`, pid, info);
}

type Liveness = "alive" | "exited" | "reused";

/** A pid that names a process started at another time is a reused pid, not the serve that was signalled. */
async function liveness(ports: PortOwnerPorts, pid: number, startedAt: string | undefined): Promise<Liveness> {
  const info = await ports.processInfo(pid);
  if (info === undefined) return "exited";
  return info.startedAt === startedAt ? "alive" : "reused";
}

async function awaitGone(ports: PortOwnerPorts, pid: number, startedAt: string | undefined, budgetMs: number): Promise<Liveness> {
  const since = ports.now();
  let state: Liveness = "alive";
  for (let poll = 0; poll * PORT_POLL_MS < budgetMs; poll++) {
    state = await liveness(ports, pid, startedAt);
    if (state !== "alive" || ports.now() - since >= budgetMs) break;
    await ports.sleep(PORT_POLL_MS);
  }
  return state;
}

async function terminate(ports: PortOwnerPorts, line: string, pid: number, info: ProcessInfo): Promise<ForeignFence> {
  const since = ports.now();
  ports.signal(pid, "SIGTERM");
  const termed = await awaitGone(ports, pid, info.startedAt, FOREIGN_TERM_MS);
  const beforeKill = termed === "alive" ? await liveness(ports, pid, info.startedAt) : termed;
  if (beforeKill === "alive") return kill(ports, line, pid, info);
  if (beforeKill === "exited") ports.log(`${line}: SIGTERM, exited after ${seconds(ports.now() - since)}\n`);
  else ports.log(`${line}: SIGTERM; the pid now names another process, so no SIGKILL was sent\n`);
  return { ok: true };
}

async function kill(ports: PortOwnerPorts, line: string, pid: number, info: ProcessInfo): Promise<ForeignFence> {
  ports.signal(pid, "SIGKILL");
  ports.log(`${line}: SIGKILL after ${seconds(FOREIGN_TERM_MS)}\n`);
  if ((await awaitGone(ports, pid, info.startedAt, FOREIGN_KILL_MS)) !== "alive") return { ok: true };
  return { ok: false, why: `pid ${pid} (titan-factory serve) still runs ${seconds(FOREIGN_TERM_MS + FOREIGN_KILL_MS)} after SIGTERM, SIGKILL included` };
}
