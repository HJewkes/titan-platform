/** What the update lock touches; tests pass an in-memory file map. */
export interface LockPorts {
  pid: number;
  /** False when the file already exists. */
  createExclusive: (file: string, text: string) => boolean;
  readFile: (file: string) => string | undefined;
  remove: (file: string) => void;
  isAlive: (pid: number) => boolean;
}

const holderOf = (ports: LockPorts, file: string): number | undefined => {
  const pid = Number(ports.readFile(file)?.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};

/** Undefined when this process now holds `file`, else why not. A lock whose pid is gone is stale and is taken over once. */
export function takeLock(ports: LockPorts, file: string): string | undefined {
  const mine = String(ports.pid);
  if (ports.createExclusive(file, mine)) return undefined;
  const holder = holderOf(ports, file);
  if (holder !== undefined && ports.isAlive(holder)) return `another self-update is running (pid ${holder} holds ${file})`;
  ports.remove(file);
  return ports.createExclusive(file, mine) ? undefined : `another self-update took ${file} first`;
}

/** Removes the lock only while it still names this process. */
export function releaseLock(ports: LockPorts, file: string): void {
  if (holderOf(ports, file) === ports.pid) ports.remove(file);
}
