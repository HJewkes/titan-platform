import { SERVICE_LABEL } from "./service.js";
import { settledHealth, type ServiceIo, type ServicePorts } from "./service-control.js";

/** The causes in the order `check` tests them; the first that holds is the one reported. */
export type Cause = "not loaded" | "stale pid" | "crash loop" | "stale build" | "GitHub down";

/** What `check` reads beyond `ServicePorts`; every one is read-only, so a fake never has to model a mutation. */
export interface CheckPorts extends ServicePorts {
  isAlive: (pid: number) => boolean;
  /** When the process at `pid` started, or null when it has none. */
  processStartedAt: (pid: number) => Promise<Date | null>;
  /** The build sha of the dist this CLI runs from, which is the installed build; `unknown` when it carries none. */
  installedBuildSha: () => string;
}

export interface CheckResult {
  ok: boolean;
  cause: Cause | null;
  message: string;
  /** The launchd pid, absent when the job is not loaded or holds no process. */
  pid?: number;
  /** The `/health` body, or null when nothing answered. */
  health: Record<string, unknown> | null;
  detail: Record<string, string | number | null>;
}

/** A job that exited non-zero and has started at least this many times, and whose process is missing or younger than the window, is crash-looping. */
export const CRASH_LOOP_MIN_RUNS = 3;
export const CRASH_LOOP_WINDOW_MS = 5 * 60_000;
const UNKNOWN = "unknown";
const FAILURE = 1;

interface Job {
  loaded: boolean;
  pid?: number;
  runs?: number;
  lastExit?: number;
}

const field = (text: string, name: string): number | undefined => {
  const value = new RegExp(`^\\s*${name} = (-?\\d+)\\b`, "m").exec(text)?.[1];
  return value === undefined ? undefined : Number(value);
};

async function readJob(ports: CheckPorts): Promise<Job> {
  const printed = await ports.launchctl(["print", `gui/${ports.uid}/${SERVICE_LABEL}`]);
  if (printed.code !== 0) return { loaded: false };
  const [pid, runs, lastExit] = [field(printed.stdout, "pid"), field(printed.stdout, "runs"), field(printed.stdout, "last exit code")];
  return { loaded: true, ...(pid === undefined ? {} : { pid }), ...(runs === undefined ? {} : { runs }), ...(lastExit === undefined ? {} : { lastExit }) };
}

async function isCrashLoop(ports: CheckPorts, job: Job): Promise<boolean> {
  if (!job.lastExit || (job.runs ?? 0) < CRASH_LOOP_MIN_RUNS) return false;
  if (job.pid === undefined) return true;
  const started = await ports.processStartedAt(job.pid);
  return started !== null && ports.now() - started.getTime() < CRASH_LOOP_WINDOW_MS;
}

function runningSha(health: Record<string, unknown> | null): string | undefined {
  const sha = typeof health?.build === "object" && health.build !== null ? (health.build as Record<string, unknown>).sha : undefined;
  return typeof sha === "string" ? sha : undefined;
}

/** Only a clean, known pair can differ meaningfully: an `unknown` build has no sha to compare. */
function isStaleBuild(running: string | undefined, installed: string): boolean {
  return running !== undefined && running !== UNKNOWN && installed !== UNKNOWN && running !== installed;
}

function verdict(cause: Cause | null, message: string, job: Job, health: Record<string, unknown> | null, detail: CheckResult["detail"] = {}): CheckResult {
  return { ok: cause === null, cause, message, ...(job.pid === undefined ? {} : { pid: job.pid }), health, detail };
}

/** Never starts, stops or restarts the job: it reads launchctl, ps, /health and the installed build only. */
export async function diagnoseService(ports: CheckPorts, port: number): Promise<CheckResult> {
  const job = await readJob(ports);
  if (!job.loaded) return verdict("not loaded", `${SERVICE_LABEL} is not loaded; run titan-factory service install`, job, null);
  const health = await settledHealth(ports, port);
  const healthPid = typeof health?.pid === "number" ? health.pid : undefined;
  const stale = stalePid(ports, job, healthPid, port);
  if (stale) return verdict("stale pid", stale, job, health, { healthPid: healthPid ?? null });
  if (await isCrashLoop(ports, job)) return crashLoop(job, health);
  if (health?.ok !== true || healthPid !== job.pid) return verdict("stale pid", unansweredWhy(job, port), job, health, { healthPid: healthPid ?? null });
  return judgeRunning(job, health, ports.installedBuildSha());
}

const RESTART = "stop any other process on the port, then run titan-factory service restart";

/** The pid launchd reports is dead, or a different live process answers /health on the port. */
function stalePid(ports: CheckPorts, job: Job, healthPid: number | undefined, port: number): string | undefined {
  if (job.pid !== undefined && !ports.isAlive(job.pid)) return `launchd pid ${job.pid} is dead; ${RESTART}`;
  if (job.pid !== undefined && healthPid !== undefined && healthPid !== job.pid) return `port ${port} is answered by pid ${healthPid}, not launchd pid ${job.pid}; ${RESTART}`;
  return undefined;
}

/** What is left once crash loop is ruled out: launchd has no process, or its process gives no usable /health answer. */
const unansweredWhy = (job: Job, port: number): string =>
  `${job.pid === undefined ? "launchd holds no process" : `launchd pid ${job.pid} does not answer /health on port ${port}`}; ${RESTART}`;

function crashLoop(job: Job, health: Record<string, unknown> | null): CheckResult {
  const message = `${SERVICE_LABEL} is crash-looping: last exit ${job.lastExit}, ${job.runs} runs; read serve.err.log in the service log directory, fix it, then run titan-factory service restart`;
  return verdict("crash loop", message, job, health, { lastExitCode: job.lastExit ?? null, runs: job.runs ?? null });
}

function judgeRunning(job: Job, health: Record<string, unknown>, installed: string): CheckResult {
  const running = runningSha(health);
  if (isStaleBuild(running, installed)) {
    const message = `the server runs build ${running} but the installed dist is build ${installed}; run titan-factory service restart`;
    return verdict("stale build", message, job, health, { runningBuild: running ?? null, installedBuild: installed });
  }
  if (health.github !== "ok") return verdict("GitHub down", `/health answers from pid ${job.pid} but its GitHub check is not ok: ${String(health.github)}; run gh auth status`, job, health, { github: String(health.github) });
  return verdict(null, `ok: /health answers from pid ${job.pid} with github ok`, job, health);
}

export async function checkService(ports: CheckPorts, io: ServiceIo, port: number, json: boolean): Promise<number> {
  const result = await diagnoseService(ports, port);
  io.stdout(json ? `${JSON.stringify(result)}\n` : `${result.cause === null ? "" : `${result.cause}: `}${result.message}\n`);
  return result.ok ? 0 : FAILURE;
}
