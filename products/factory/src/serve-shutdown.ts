import type { Logger } from "@titan-design/daemon";
import type { Sweep } from "./sweep.js";

/** How long close waits, in total, for sweep ticks already running; a tick can sit on a 30 s agent-chat or gh timeout, and systemd shows `deactivating` all that time. */
export const SHUTDOWN_SWEEP_GRACE_MS = 5_000;

interface ClosingParts {
  sweeps: readonly (Sweep | undefined)[];
  /** Stopped after the grace, in order, then the main watch, the daemon, the carry binding and the database. */
  watches: readonly { stop(): void }[];
  mainWatch: { close(): void } | undefined;
  daemon: { close(): Promise<void> };
  unbindCarry(): void;
  host: { runtime: { shutdown(): void }; close(): void };
}

/** The runtime lets its runs go before anything is awaited, so a successor can claim them and this process starts no more step work. */
export async function closeServer(parts: ClosingParts, log: Logger, graceMs: number): Promise<void> {
  const started = Date.now();
  const live = parts.sweeps.filter((sweep): sweep is Sweep => sweep !== undefined);
  for (const sweep of live) sweep.halt();
  parts.host.runtime.shutdown();
  const abandoned = await awaitTicks(live, graceMs);
  for (const watch of parts.watches) watch.stop();
  parts.mainWatch?.close();
  await parts.daemon.close();
  parts.unbindCarry();
  parts.host.close();
  log.info({ ms: Date.now() - started, ...(abandoned.length > 0 && { abandoned }) }, "closed");
}

/** The names of sweeps whose tick was still running when the grace ran out; that tick's later failure is caught and logged by its sweep. */
async function awaitTicks(sweeps: readonly Sweep[], graceMs: number): Promise<string[]> {
  const pending = new Set(sweeps.filter((sweep) => sweep.inFlight() !== null));
  const ticks = [...pending].map((sweep) => sweep.inFlight()!.then(() => pending.delete(sweep)));
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
    timer.unref();
  });
  await Promise.race([Promise.allSettled(ticks), grace]);
  clearTimeout(timer);
  return [...pending].map((sweep) => sweep.name);
}
