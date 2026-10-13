import { DaemonAlreadyRunningError, type Logger } from "@titan-design/daemon";
import { probeServe, type ServeProbe } from "./serve-probe.js";

export type HealthProbe = (port: number) => Promise<ServeProbe>;

/**
 * A second serve beside a live factory gets null, so it exits 0 and a supervisor that restarts only on failure leaves it be.
 * Only a factory whose /health pid matches the pid file counts; anything else stays a failure.
 */
export async function startUnlessLive<T>(start: () => Promise<T>, log: Logger, probe: HealthProbe = probeServe): Promise<T | null> {
  try {
    return await start();
  } catch (err) {
    if (!(err instanceof DaemonAlreadyRunningError)) throw err;
    const health = await probe(err.port);
    if (health.state !== "up" || health.health.pid !== err.pid) throw err;
    log.info({ pid: err.pid, port: err.port }, `a live titan-factory, pid ${err.pid}, holds port ${err.port}; this serve exits 0`);
    return null;
  }
}
