type Health = Record<string, unknown>;

/** How long a freshly deployed serve is watched after its sha checks out, and how often. */
export interface WatchWindow {
  windowMs: number;
  intervalMs: number;
  /** Probes in a row with no answer before serve counts as down; one slow answer under load is not. */
  missLimit: number;
}

export const DEFAULT_WATCH_WINDOW: WatchWindow = { windowMs: 120_000, intervalMs: 10_000, missLimit: 3 };

/** What the watch reads; the deployer passes its own `/health` probe and clock. */
export interface WatchPorts {
  probe: () => Promise<Health | null>;
  sleep: (ms: number) => Promise<void>;
}

export function buildShaOf(health: Health | null | undefined): string | undefined {
  const build = health?.build;
  const sha = typeof build === "object" && build !== null ? (build as Health).sha : undefined;
  return typeof sha === "string" ? sha : undefined;
}

/** Runs that failed or need recovery; a count that grows during the window is a new step error. */
function erroredRuns(health: Health): number {
  const runs = typeof health.runs === "object" && health.runs !== null ? (health.runs as Health) : {};
  return [runs.failed, runs.recovery_required].reduce<number>((sum, count) => sum + (typeof count === "number" ? count : 0), 0);
}

function drift(baseline: Health, health: Health, target: string): string | undefined {
  const sha = buildShaOf(health);
  if (sha !== target) return `/health reports build ${sha ?? "none"}, not ${target}`;
  if (health.pid !== baseline.pid) return `serve restarted (pid ${String(baseline.pid)} -> ${String(health.pid)})`;
  const added = erroredRuns(health) - erroredRuns(baseline);
  return added > 0 ? `${added} more run(s) failed or need recovery` : undefined;
}

/** Undefined when serve held steady for the whole window, else why not; `baseline` is the answer that confirmed the sha. */
export async function watchServe(ports: WatchPorts, baseline: Health, target: string, window: WatchWindow): Promise<string | undefined> {
  const interval = Math.max(1, window.intervalMs);
  const during = `during the ${Math.round(window.windowMs / 1000)} s watch`;
  let misses = 0;
  for (let waited = 0; waited < window.windowMs; waited += interval) {
    await ports.sleep(interval);
    const health = await ports.probe();
    misses = health === null ? misses + 1 : 0;
    if (misses >= Math.max(1, window.missLimit)) return `serve stopped answering /health (${misses} probes in a row) ${during}`;
    const why = health === null ? undefined : drift(baseline, health, target);
    if (why !== undefined) return `${why} ${during}`;
  }
  return undefined;
}
