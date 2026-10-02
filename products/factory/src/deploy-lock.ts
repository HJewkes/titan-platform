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

/** Undefined when this process now holds `lock`, else why not; a lock whose pid is gone is stale and is taken over. */
export function takeLock(ports: LockPorts, lock: string): string | undefined {
  const mine = String(ports.pid);
  if (ports.createExclusive(lock, mine)) return undefined;
  const holder = lockPid(ports, lock);
  if (holder !== undefined && ports.isAlive(holder)) return `another deploy is running (pid ${holder} holds ${lock})`;
  return stealStale(ports, lock, holder) ?? (ports.createExclusive(lock, mine) ? undefined : `another deploy took ${lock} first`);
}

/** Only one stealer's rename succeeds; one that moved a fresh lock instead of the stale one puts it back and stands down. */
function stealStale(ports: LockPorts, lock: string, stale: number | undefined): string | undefined {
  const claimed = `${lock}.${ports.pid}.stale`;
  if (!ports.rename(lock, claimed)) return `another deploy took ${lock} first`;
  const moved = lockPid(ports, claimed);
  ports.remove(claimed);
  if (moved === stale) return undefined;
  if (moved !== undefined) ports.createExclusive(lock, String(moved));
  return `another deploy took ${lock} first`;
}

/** Removes `lock` only while it still names this process, so a lock another deployer took over survives. */
export function releaseLock(ports: LockPorts, lock: string): void {
  if (lockPid(ports, lock) === ports.pid) ports.remove(lock);
}
