type Health = Record<string, unknown>;

/** How long a freshly deployed serve is watched after its sha checks out, and how often. */
export interface WatchWindow {
  windowMs: number;
  intervalMs: number;
  /** Probes in a row with no answer before serve counts as down; one slow answer under load is not. */
  missLimit: number;
}

export const DEFAULT_WATCH_WINDOW: WatchWindow = { windowMs: 120_000, intervalMs: 10_000, missLimit: 3 };

/** The first probe of a tick waits this long; a timeout from a live pid is then retried for `SLOW_PROBE_TIMEOUT_MS`. */
export const FAST_PROBE_TIMEOUT_MS = 5_000;
export const SLOW_PROBE_TIMEOUT_MS = 30_000;

/** What the watch reads; the deployer passes its own `/health` probe, clock and pid check. */
interface WatchPorts {
  probe: (timeoutMs: number) => Promise<Health | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  alive: (pid: number) => boolean;
}

/** A named field of an object, or undefined for anything else; `/health` is untrusted JSON. */
const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Object.entries(value).find(([name]) => name === key)?.[1] : undefined);

export function buildShaOf(health: Health | null | undefined): string | undefined {
  const sha = field(health?.build, "sha");
  return typeof sha === "string" ? sha : undefined;
}

/** Runs that failed or need recovery; a count that grows during the window is a new step error. */
function erroredRuns(health: Health): number {
  return [field(health.runs, "failed"), field(health.runs, "recovery_required")].reduce<number>((sum, count) => sum + (typeof count === "number" ? count : 0), 0);
}

function drift(baseline: Health, health: Health, target: string): string | undefined {
  const sha = buildShaOf(health);
  if (sha !== target) return `/health reports build ${sha ?? "none"}, not ${target}`;
  if (health.pid !== baseline.pid) return `serve restarted (pid ${String(baseline.pid)} -> ${String(health.pid)})`;
  const added = erroredRuns(health) - erroredRuns(baseline);
  return added > 0 ? `${added} more run(s) failed or need recovery` : undefined;
}

/** How one tick's probe went: a quick answer, an answer after the retry, or a live pid that never answered. */
interface Reading {
  health: Health | null;
  slow: boolean;
  latencyMs: number;
}

/** A null from a live pid is a stall, not a death: the restarted process is still there to answer later. */
async function read(ports: WatchPorts, baseline: Health): Promise<Reading> {
  const started = ports.now();
  const quick = await ports.probe(FAST_PROBE_TIMEOUT_MS);
  if (quick !== null) return { health: quick, slow: false, latencyMs: ports.now() - started };
  const pid = baseline.pid;
  if (typeof pid !== "number" || !ports.alive(pid)) return { health: null, slow: false, latencyMs: ports.now() - started };
  const retried = await ports.probe(SLOW_PROBE_TIMEOUT_MS);
  return { health: retried, slow: true, latencyMs: ports.now() - started };
}

const describeLatency = ({ health, latencyMs }: Reading): string => (health === null ? `no answer in ${Math.round(latencyMs / 1000)} s` : `${(latencyMs / 1000).toFixed(1)} s`);

/**
 * Undefined when serve held steady for the whole window, else why not; `baseline` is the answer that confirmed the sha.
 * Only a probe with no answer from a dead pid counts toward the miss limit; a timeout while the pid lives is slow, and a window of nothing but slow probes rolls back.
 * A miss still open when the window ends keeps the watch probing until an answer or the miss limit, so a serve that dies late is not deployed.
 */
export async function watchServe(ports: WatchPorts, baseline: Health, target: string, window: WatchWindow): Promise<string | undefined> {
  const interval = Math.max(1, window.intervalMs);
  const during = `during the ${Math.round(window.windowMs / 1000)} s watch`;
  const readings: Reading[] = [];
  let misses = 0;
  for (let waited = 0; waited < window.windowMs || misses > 0; waited += interval) {
    await ports.sleep(interval);
    const reading = await read(ports, baseline);
    readings.push(reading);
    const { health } = reading;
    misses = health === null && !reading.slow ? misses + 1 : 0;
    if (misses >= Math.max(1, window.missLimit)) return `serve stopped answering /health (${misses} probes in a row) ${during}`;
    const why = health === null ? undefined : drift(baseline, health, target);
    if (why !== undefined) return `${why} ${during}`;
  }
  const allSlow = readings.length > 0 && readings.every((reading) => reading.slow);
  return allSlow ? `serve answered slowly on every probe (${readings.map(describeLatency).join(", ")}) ${during}` : undefined;
}
