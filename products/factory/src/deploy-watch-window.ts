type Health = Record<string, unknown>;

/** How long a freshly deployed serve is watched after its sha checks out, and how often. */
export interface WatchWindow {
  windowMs: number;
  intervalMs: number;
  /** Probes in a row with no answer before serve counts as down; one slow answer under load is not. */
  missLimit: number;
}

/**
 * No start-up grace: the sha poll already waited for a first answer, and three live-pid misses take about 3 × 45 s,
 * longer than this window and the 17–32 s Shepherd resync after a restart (TP-2433). A grace would only hide a serve hung from the start.
 */
export const DEFAULT_WATCH_WINDOW: WatchWindow = { windowMs: 120_000, intervalMs: 10_000, missLimit: 3 };

/** The first probe of a tick waits this long; a timeout from a live pid is then retried for `SLOW_PROBE_TIMEOUT_MS`. */
export const FAST_PROBE_TIMEOUT_MS = 5_000;
export const SLOW_PROBE_TIMEOUT_MS = 30_000;

/**
 * What a deploy's watch sets out to prove: build `sha` stays up and breaks no run until `windowEnd`, epoch ms. The watch records it as the window opens
 * and reads `windowEnd` on every tick, so a later change can move it.
 */
export interface WatchIntent {
  sha: string;
  windowEnd: number;
}

/** What the watch reads; the deployer passes its own `/health` probe, clock and pid check. */
interface WatchPorts {
  probe: (timeoutMs: number) => Promise<Health | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  alive: (pid: number) => boolean;
  /** Called once as the window opens; absent records nothing. */
  record?: (intent: WatchIntent) => void;
}

/** How serve stood just before the restart and just after it. */
export interface WatchBaseline {
  /** The answer that confirmed the sha; the pid is held to it. */
  confirmed: Health;
  /** The drain's last answer before the restart, or null when serve was silent then; run errors are judged against it. */
  atRestart: Health | null;
}

/** A named field of an object, or undefined for anything else; `/health` is untrusted JSON. */
const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Object.entries(value).find(([name]) => name === key)?.[1] : undefined);

export function buildShaOf(health: Health | null | undefined): string | undefined {
  const sha = field(health?.build, "sha");
  return typeof sha === "string" ? sha : undefined;
}

const RECOVERY = "recovery_required";

const count = (health: Health, status: string): number => {
  const value = field(health.runs, status);
  return typeof value === "number" ? value : 0;
};

/** The ids `/health` lists as recovery_required, or undefined from a build that counts them only. */
function recoveryIds(health: Health): readonly string[] | undefined {
  const ids = health.recoveryRequired;
  return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? (ids as string[]) : undefined;
}

/** The ids the drain still saw busy when it let the restart go. */
function interruptedBy(atRestart: Health | null): ReadonlySet<string> {
  const busy: unknown[] = Array.isArray(atRestart?.busy) ? atRestart.busy : [];
  return new Set(busy.map((run) => field(run, "runId")).filter((id): id is string => typeof id === "string"));
}

/**
 * Runs parked as recovery_required since `before`, leaving out runs the restart interrupted mid-step: parking them is what a restart does.
 * A `before` that counts without listing ids stands for its count of parked runs.
 */
function newlyParked(before: Health, end: Health, interrupted: ReadonlySet<string>): number {
  const now = recoveryIds(end);
  if (now === undefined) return count(end, RECOVERY) - count(before, RECOVERY);
  const fresh = now.filter((id) => !interrupted.has(id));
  const was = recoveryIds(before);
  return was === undefined ? fresh.length - count(before, RECOVERY) : fresh.filter((id) => !was.includes(id)).length;
}

/**
 * Run errors the window added, judged once at its end, so a held run that reads recovery_required for a tick while it is re-adopted is none.
 * Every new failed run counts: a restart repeats or parks a step and never fails one, so a failure has a new cause.
 */
function addedErrors({ confirmed, atRestart }: WatchBaseline, end: Health): number {
  const before = atRestart ?? confirmed;
  return Math.max(0, count(end, "failed") - count(before, "failed")) + Math.max(0, newlyParked(before, end, interruptedBy(atRestart)));
}

/** A wrong sha or a new pid is no blip, so either ends the watch on the tick that reads it. */
function drift(baseline: Health, health: Health, target: string): string | undefined {
  const sha = buildShaOf(health);
  if (sha !== target) return `/health reports build ${sha ?? "none"}, not ${target}`;
  return health.pid === baseline.pid ? undefined : `serve restarted (pid ${String(baseline.pid)} -> ${String(health.pid)})`;
}

/** One tick's liveness: an answer or none, either after the slow retry or without it. */
type Reading = { kind: "answer"; health: Health; slow: boolean; latencyMs: number } | { kind: "miss"; slow: boolean; latencyMs: number };

/** A live pid earns a null a second, longer probe before the tick gives up; a dead pid cannot answer, so it gets none. */
async function read(ports: WatchPorts, baseline: Health): Promise<Reading> {
  const started = ports.now();
  const answered = (health: Health | null, slow: boolean): Reading => (health === null ? { kind: "miss", slow, latencyMs: ports.now() - started } : { kind: "answer", health, slow, latencyMs: ports.now() - started });
  const quick = await ports.probe(FAST_PROBE_TIMEOUT_MS);
  if (quick !== null) return answered(quick, false);
  const pid = baseline.pid;
  if (typeof pid !== "number" || !ports.alive(pid)) return answered(null, false);
  return answered(await ports.probe(SLOW_PROBE_TIMEOUT_MS), true);
}

const describeLatency = (reading: Reading): string => (reading.kind === "miss" ? `no answer in ${Math.round(reading.latencyMs / 1000)} s` : `${(reading.latencyMs / 1000).toFixed(1)} s`);

/**
 * The window's verdict once it has run out; the last tick is an answer, since a miss keeps the window open.
 * Run errors must stand on the last two answers, so no single tick decides them.
 */
function atWindowEnd(readings: readonly Reading[], baseline: WatchBaseline, during: string): string | undefined {
  const answers = readings.flatMap((reading) => (reading.kind === "answer" ? [reading.health] : [])).slice(-2);
  if (answers.length === 0) return undefined;
  const added = Math.min(...answers.map((health) => addedErrors(baseline, health)));
  if (added > 0) return `${added} more run(s) failed or need recovery ${during}`;
  return readings.every((reading) => reading.slow) ? `serve answered slowly on every probe (${readings.map(describeLatency).join(", ")}) ${during}` : undefined;
}

/**
 * Undefined when serve held steady for the whole window, else why not; `baseline.confirmed` is the answer that confirmed the sha.
 * Every tick with no answer counts toward the miss limit, whether or not the pid lives; a live pid only buys the slower retry first.
 * An answer that needed the retry is slow, not a miss, and a window of nothing but slow probes rolls back.
 * A miss still open when the window ends keeps the watch probing until an answer or the miss limit, so a serve that dies or hangs late is not deployed.
 * Run errors are judged at the end only: a run re-adopted after the restart may read recovery_required for a tick or two.
 */
export async function watchServe(ports: WatchPorts, baseline: WatchBaseline, target: string, window: WatchWindow): Promise<string | undefined> {
  const interval = Math.max(1, window.intervalMs);
  const intent: WatchIntent = { sha: target, windowEnd: ports.now() + window.windowMs };
  ports.record?.(intent);
  const during = `during the ${Math.round(window.windowMs / 1000)} s watch`;
  const readings: Reading[] = [];
  let misses = 0;
  while (ports.now() < intent.windowEnd || misses > 0) {
    await ports.sleep(interval);
    const reading = await read(ports, baseline.confirmed);
    readings.push(reading);
    misses = reading.kind === "miss" ? misses + 1 : 0;
    if (misses >= Math.max(1, window.missLimit)) return `serve stopped answering /health (${misses} probes in a row) ${during}`;
    const why = reading.kind === "answer" ? drift(baseline.confirmed, reading.health, target) : undefined;
    if (why !== undefined) return `${why} ${during}`;
  }
  return atWindowEnd(readings, baseline, during);
}
