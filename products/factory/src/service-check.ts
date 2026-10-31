import type { Command } from "commander";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import { parsePort } from "./cli-options.js";
import { DIRTY_SUFFIX, PROBE_PENDING } from "./build-info.js";
import { deployBlockOf, type DeployHealth } from "./deploy-health.js";
import { EXIT } from "./exit-codes.js";
import { FACTORY_PORT } from "./serve.js";
import { serviceLabel, UNIT_NAME } from "./service.js";
import { MANAGED_PLATFORMS, runServiceVerb, type ServiceIo, type ServicePorts } from "./service-control.js";
import { SERVICE_CHECK_HEALTH_TIMEOUT_MS } from "./service-ports.js";
import { describeIndexLock, type IndexLock } from "./stale-lock.js";
import { judgeTick, type TickStatusRead } from "./tick-status.js";
import { readPath } from "./narrow.js";

/** The causes in the order `check` tests them; the first that holds is the one reported. `stale CLI` alone is advisory: it leaves the check ok. */
type Cause = "unreadable" | "not loaded" | "socket down" | "restarting" | "stale pid" | "crash loop" | "unresponsive" | "stale build" | "GitHub down" | "stale index.lock" | "deploy stalled" | "tick failing" | "tick stale" | "no hub seat" | "stale CLI";

/** What `check` reads beyond `ServicePorts`; every one is read-only, so a fake never has to model a mutation. */
export interface CheckPorts extends ServicePorts {
  isAlive: (pid: number) => boolean;
  /** When the process at `pid` started, or null when it has none. */
  processStartedAt: (pid: number) => Promise<Date | null>;
  /** The build sha baked into the deploy checkout's dist, which is what a restart runs (it rebuilds nothing, so HEAD may be ahead); undefined when it cannot be read. */
  restartTargetSha: () => Promise<string | undefined>;
  /** True when `ancestor` is an ancestor of `descendant` in the deploy checkout; false when either is unknown to it. */
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>;
  /** The burndown tick's status file path and its text, undefined when the file is absent. */
  tickStatus: () => TickStatusRead;
  /** The service checkout's .git/index.lock, read only: a stale one blocks every later deploy, and only a person removes it. */
  indexLock: () => Promise<IndexLock>;
  /** The config's shepherd.hubSeat, the seat a deploy alarm reaches; undefined when none is set. */
  hubSeat: () => string | undefined;
  /** The bare `titan-factory` on PATH, resolved through symlinks, and the build sha baked into its dist; undefined when none is on PATH. */
  installedCli: () => Promise<{ path: string; sha: string | undefined } | undefined>;
  /** HEAD of the deploy checkout, the commit `service deploy` builds; undefined when git cannot read it. */
  checkoutHead: () => Promise<string | undefined>;
  /** The deploy checkout's dist/bin.js, resolved through symlinks. */
  deployBin: string;
}

interface CheckResult {
  ok: boolean;
  cause: Cause | null;
  message: string;
  /** The launchd or systemd pid, absent when the job is not loaded or holds no process. */
  pid?: number;
  /** The `/health` body, or null when nothing answered. */
  health: Record<string, unknown> | null;
  detail: Record<string, string | number | null>;
}

/** A job that exited non-zero and has started at least this many times, and whose process is missing or younger than the window, is crash-looping. */
const CRASH_LOOP_MIN_RUNS = 3;
export const CRASH_LOOP_WINDOW_MS = 5 * 60_000;
const UNKNOWN = "unknown";
const RESTARTING_RETRY_S = 10;
const SOCKET_UNIT = "titan-factory.socket";

type Manager = "launchd" | "systemd";

interface Job {
  manager: Manager;
  loaded: boolean;
  pid?: number;
  runs?: number;
  lastExit?: number;
  /** systemd only: the unit's ActiveState and SubState, which tell a restart in flight from a unit that holds no process. */
  activeState?: string;
  subState?: string;
  /** systemd only: the socket unit, `absent` when none is installed. `down` means it is loaded but not active. */
  socket?: "listening" | "down" | "absent";
  /** Set when the manager itself could not be read, so whether the job is loaded is unknown. */
  unreadable?: { exitCode: number; stderr: string };
}

const field = (text: string, name: string): number | undefined => {
  const value = new RegExp(`^\\s*${name} = (-?\\d+)\\b`, "m").exec(text)?.[1];
  return value === undefined ? undefined : Number(value);
};

function loadedJob(manager: Manager, pid: number | undefined, runs: number | undefined, lastExit: number | undefined): Job {
  return { manager, loaded: true, ...(pid === undefined ? {} : { pid }), ...(runs === undefined ? {} : { runs }), ...(lastExit === undefined ? {} : { lastExit }) };
}

async function readLaunchdJob(ports: CheckPorts): Promise<Job> {
  const printed = await ports.launchctl(["print", `gui/${ports.uid}/${serviceLabel(ports.labelPrefix)}`]);
  if (printed.code !== 0) return { manager: "launchd", loaded: false };
  return loadedJob("launchd", field(printed.stdout, "pid"), field(printed.stdout, "runs"), field(printed.stdout, "last exit code"));
}

const UNIT_PROPERTIES = "LoadState,ActiveState,SubState,MainPID,NRestarts,ExecMainStatus";
const integer = (text: string): number | undefined => (/^-?\d+$/.test(text) ? Number(text) : undefined);

/** NRestarts stands in for launchd's runs and ExecMainStatus for its last exit code; a unit that is not active holds no process, whatever MainPID says. */
async function readUnit(ports: CheckPorts): Promise<Job> {
  const shown = await ports.systemctl(["--user", "show", UNIT_NAME, `--property=${UNIT_PROPERTIES}`]);
  const value = (key: string): string => new RegExp(`^${key}=(.*)$`, "m").exec(shown.stdout)?.[1] ?? "";
  // A missing unit file reads as exit 0 with LoadState=not-found; a non-zero exit means systemctl could not answer at all (no user bus, permission, timeout).
  if (shown.code !== 0) return { manager: "systemd", loaded: false, unreadable: { exitCode: shown.code, stderr: shown.stderr.trim() || `exit ${shown.code}` } };
  if (value("LoadState") !== "loaded") return { manager: "systemd", loaded: false };
  const pid = integer(value("MainPID"));
  const running = value("ActiveState") === "active" && pid !== undefined && pid > 0;
  const job = loadedJob("systemd", running ? pid : undefined, integer(value("NRestarts")), integer(value("ExecMainStatus")));
  return { ...job, activeState: value("ActiveState"), subState: value("SubState"), socket: await readSocket(ports) };
}

/** A socket unit that cannot be read counts as absent: it is optional, and the service's own state is judged without it. */
async function readSocket(ports: CheckPorts): Promise<NonNullable<Job["socket"]>> {
  const shown = await ports.systemctl(["--user", "show", SOCKET_UNIT, "--property=LoadState,ActiveState"]);
  if (shown.code !== 0 || !/^LoadState=loaded$/m.test(shown.stdout)) return "absent";
  return /^ActiveState=active$/m.test(shown.stdout) ? "listening" : "down";
}

const readJob = (ports: CheckPorts): Promise<Job> => (ports.platform === "linux" ? readUnit(ports) : readLaunchdJob(ports));
const jobName = (job: Job, ports: CheckPorts): string => (job.manager === "systemd" ? UNIT_NAME : serviceLabel(ports.labelPrefix));

/** `service restart` and `kickstart -k` record the killed run's non-zero exit and bump runs, so a young process that answers /health itself is a restart, not a loop. */
async function isCrashLoop(ports: CheckPorts, job: Job, answersFromJob: boolean): Promise<boolean> {
  if (!job.lastExit || (job.runs ?? 0) < CRASH_LOOP_MIN_RUNS) return false;
  if (job.pid === undefined) return true;
  if (answersFromJob) return false;
  const started = await ports.processStartedAt(job.pid);
  return started !== null && ports.now() - started.getTime() < CRASH_LOOP_WINDOW_MS;
}

function runningSha(health: Record<string, unknown> | null): string | undefined {
  const sha = readPath(health, "build", "sha");
  return typeof sha === "string" ? sha : undefined;
}

/** git cannot resolve a `-dirty` build, but its base commit still orders against others. */
const withoutDirty = (sha: string): string => (sha.endsWith(DIRTY_SUFFIX) ? sha.slice(0, -DIRTY_SUFFIX.length) : sha);

/** Stale only when a restart would move forward: a target that equals, precedes or diverges from the running build must never be advised, because that restart would roll serve back. */
async function newerRestartTarget(ports: CheckPorts, running: string | undefined): Promise<string | undefined> {
  if (running === undefined || running === UNKNOWN) return undefined;
  const target = await ports.restartTargetSha();
  if (target === undefined || target === UNKNOWN) return undefined;
  const from = withoutDirty(running);
  const to = withoutDirty(target);
  if (from === to) return undefined;
  return (await ports.isAncestor(from, to)) ? target : undefined;
}

function verdict(cause: Cause | null, message: string, job: Job, health: Record<string, unknown> | null, detail: CheckResult["detail"] = {}): CheckResult {
  return { ok: cause === null, cause, message, ...(job.pid === undefined ? {} : { pid: job.pid }), health, detail };
}

/** Never starts, stops or restarts the job: it reads launchctl or systemctl, ps, /health and the deploy checkout's commits only. */
async function diagnoseService(ports: CheckPorts, port: number): Promise<CheckResult> {
  const deadline = ports.now() + SERVICE_CHECK_BUDGET_MS - AFTER_PROBES_MS;
  const job = await readJob(ports);
  if (job.unreadable) return unreadable(job, job.unreadable);
  if (!job.loaded) return verdict("not loaded", `${jobName(job, ports)} is not loaded; run titan-factory service install`, job, null);
  if (job.socket === "down") return socketDown(job);
  const probes = await probeHealth(ports, job, port, deadline);
  const { health } = probes;
  const healthPid = typeof health?.pid === "number" ? health.pid : undefined;
  const stale = stalePid(ports, job, healthPid, port);
  if (stale) return verdict("stale pid", stale, job, health, { healthPid: healthPid ?? null });
  const answersFromJob = health?.ok === true && healthPid === job.pid;
  if (await isCrashLoop(ports, job, answersFromJob)) return crashLoop(job, jobName(job, ports), health);
  if (!answersFromJob) return unanswered(job, port, probes, healthPid);
  return withDeployWait(await judgeAnswering(ports, job, health));
}

async function judgeAnswering(ports: CheckPorts, job: Job, health: Record<string, unknown>): Promise<CheckResult> {
  const running = await judgeRunning(ports, job, health);
  if (!running.ok) return running;
  const judged = (await withDeploy(running, ports)) ?? withTick(running, ports);
  const configured = judged.ok ? withHubSeat(judged, ports) : judged;
  return configured.ok ? withInstalledCli(configured, ports) : configured;
}

interface DeployWait {
  sha: string;
  why: string;
  until: string | null;
}

function deployWaitOf(health: Record<string, unknown> | null): DeployWait | undefined {
  const pending = health?.deployPending;
  if (!isObjectLike(pending) || !isObjectLike(pending.waiting)) return undefined;
  const { sha } = pending;
  const { why, until } = pending.waiting;
  if (typeof sha !== "string" || typeof why !== "string") return undefined;
  return { sha, why, until: typeof until === "string" ? until : null };
}

/** Whatever the verdict, a deploy the pacer holds says why on the same line, so "main ahead" never reads as stuck (TP-2427). */
function withDeployWait(result: CheckResult): CheckResult {
  const wait = deployWaitOf(result.health);
  if (wait === undefined) return result;
  const message = `${result.message}; deploy ${wait.sha} waits: ${wait.why}${wait.until === null ? "" : ` until ${wait.until}`}`;
  return { ...result, message, detail: { ...result.detail, deployWaitSha: wait.sha, deployWaitWhy: wait.why, deployWaitUntil: wait.until } };
}

function socketDown(job: Job): CheckResult {
  const message = `${SOCKET_UNIT} is loaded but not active; run systemctl --user start ${SOCKET_UNIT} (or titan-factory service install)`;
  return verdict("socket down", message, job, null, { activeState: job.activeState ?? null, subState: job.subState ?? null, socket: "down" });
}

function unreadable(job: Job, failure: NonNullable<Job["unreadable"]>): CheckResult {
  const message = `systemctl --user show ${UNIT_NAME} failed: ${failure.stderr}; run check as the service user in a session with a user bus (XDG_RUNTIME_DIR=/run/user/<uid>)`;
  return verdict("unreadable", message, job, null, { exitCode: failure.exitCode, stderr: failure.stderr });
}

/** The whole check prints inside this, every probe included; agent-chat's reads of it wait 30 s (TP-2451). */
export const SERVICE_CHECK_BUDGET_MS = 20_000;
/** Kept back from the probes for the local reads after them: ps, the deploy checkout's git history and its index lock. */
const AFTER_PROBES_MS = 2_000;
/** A probe cut shorter than this would read a merely slow serve as silent, so the check stops probing instead. */
const MIN_PROBE_MS = 1_000;
/** One failed read is not an outage: serve can miss a single probe while up, so a live job pid gets a few more polls before the answer counts. */
const EXTRA_PROBES = 2;
const PROBE_GAP_MS = 1_500;
/** serve reports `checking` until its first gh probe lands, within its 10 s timeout. */
const SETTLE_POLL_MS = 250;

interface Probes {
  health: Record<string, unknown> | null;
  latenciesMs: number[];
  /** Probes that got no usable answer; zero once one does. */
  failed: number;
  /** True when every probe gave no answer only because its timeout ran out, as a hung serve does; a refused connection returns at once. */
  allTimedOut: boolean;
}

async function timedProbe(ports: CheckPorts, port: number, deadline: number): Promise<{ health: Record<string, unknown> | null; latencyMs: number; timedOut: boolean }> {
  const timeoutMs = Math.max(MIN_PROBE_MS, Math.min(SERVICE_CHECK_HEALTH_TIMEOUT_MS, deadline - ports.now()));
  const started = ports.now();
  const health = await ports.health(port, timeoutMs);
  const latencyMs = ports.now() - started;
  return { health, latencyMs, timedOut: health === null && latencyMs >= timeoutMs };
}

/** Each probe's timeout is cut to what is left of the budget, and no probe starts once too little is left for it to mean anything. */
async function probeHealth(ports: CheckPorts, job: Job, port: number, deadline: number): Promise<Probes> {
  const probes: Probes = { health: null, latenciesMs: [], failed: 0, allTimedOut: true };
  for (;;) {
    const probe = await timedProbe(ports, port, deadline);
    probes.health = probe.health;
    probes.latenciesMs.push(probe.latencyMs);
    probes.allTimedOut &&= probe.timedOut;
    const answered = probe.health?.ok === true;
    if (answered && probe.health?.github !== PROBE_PENDING) break;
    if (!answered && (++probes.failed > EXTRA_PROBES || job.pid === undefined || !ports.isAlive(job.pid))) break;
    const gap = answered ? SETTLE_POLL_MS : PROBE_GAP_MS;
    if (deadline - ports.now() - gap < MIN_PROBE_MS) break;
    await ports.sleep(gap);
  }
  if (probes.health?.ok === true) probes.failed = 0;
  return probes;
}

/** A stale lock comes first because it explains the refusals behind the deploy alarm. */
async function withDeploy(running: CheckResult, ports: CheckPorts): Promise<CheckResult | undefined> {
  const lock = await ports.indexLock();
  if (lock.state === "stale") {
    const detail = { lockPath: lock.path, lockAgeMinutes: Math.floor(lock.ageMs / 60_000) };
    return { ...running, ok: false, cause: "stale index.lock", message: describeIndexLock(lock)!, detail };
  }
  const deploy = deployBlockOf(running.health);
  return deploy?.alarm ? { ...running, ok: false, cause: "deploy stalled", message: deployStalled(deploy), detail: deployDetail(deploy) } : undefined;
}

const deployStalled = (deploy: DeployHealth): string => `${deploy.causes.join("; ")}; titan-factory shepherd status --json --deploy shows the deploy block`;

function deployDetail(deploy: DeployHealth): CheckResult["detail"] {
  const { runningSha, behind, behindMinutes, consecutiveRefusals, lastRefusal, unverified } = deploy;
  return { runningSha, behind, behindMinutes, consecutiveRefusals, lastRefusal: lastRefusal?.reason ?? null, ...(unverified !== undefined && { unverified }) };
}

const NO_HUB_SEAT = "shepherd.hubSeat is not set in the titan-factory config; a deploy alarm reaches no seat, so set it to the coordinating seat and run titan-factory service restart";

/** A config gap only matters once the server and its tick are sound. */
function withHubSeat(running: CheckResult, ports: CheckPorts): CheckResult {
  return ports.hubSeat() === undefined ? { ...running, ok: false, cause: "no hub seat", message: NO_HUB_SEAT, detail: {} } : running;
}

/**
 * The operator's bare `titan-factory` is what goes stale, so PATH is read rather than the running
 * process's own build. The deploy bin itself is never reported: a rolled-back deploy leaves its dist
 * behind HEAD on purpose, and a rebuild would undo the rollback.
 */
async function olderInstalledCli(ports: CheckPorts): Promise<{ path: string; sha: string; head: string } | undefined> {
  const installed = await ports.installedCli();
  if (installed?.sha === undefined || installed.sha === UNKNOWN || installed.path === ports.deployBin) return undefined;
  const head = await ports.checkoutHead();
  if (head === undefined) return undefined;
  const from = withoutDirty(installed.sha);
  if (from === head) return undefined;
  return (await ports.isAncestor(from, head)) ? { path: installed.path, sha: installed.sha, head } : undefined;
}

/** Last in order, and advisory: callers stop work on a failing check, and a stale CLI leaves serve sound. */
async function withInstalledCli(running: CheckResult, ports: CheckPorts): Promise<CheckResult> {
  const stale = await olderInstalledCli(ports);
  if (stale === undefined) return running;
  const message = `the titan-factory on PATH (${stale.path}) is build ${stale.sha}, behind the deploy checkout HEAD ${stale.head}; point it at ${ports.deployBin} (or rebuild it); service restart does not change the CLI`;
  return { ...running, cause: "stale CLI", message, detail: { installedCli: stale.path, installedBuild: stale.sha, checkoutHead: stale.head } };
}

/** A server fault is reported before the tick that depends on it. */
function withTick(running: CheckResult, ports: CheckPorts): CheckResult {
  const problem = judgeTick(ports.tickStatus(), ports.now());
  return problem === undefined ? running : { ...running, ok: false, cause: problem.cause, message: problem.message, detail: problem.detail };
}

const RESTART = "stop any other process on the port, then run titan-factory service restart";

/** The pid launchd or systemd reports is dead, or a different live process answers /health on the port. */
function stalePid(ports: CheckPorts, job: Job, healthPid: number | undefined, port: number): string | undefined {
  if (job.pid !== undefined && !ports.isAlive(job.pid)) return `${job.manager} pid ${job.pid} is dead; ${RESTART}`;
  if (job.pid !== undefined && healthPid !== undefined && healthPid !== job.pid) return `port ${port} is answered by pid ${healthPid}, not ${job.manager} pid ${job.pid}; ${RESTART}`;
  return undefined;
}

/** What is left once crash loop is ruled out: launchd or systemd has no process, or its process gives no usable /health answer. */
function unanswered(job: Job, port: number, probes: Probes, healthPid: number | undefined): CheckResult {
  const detail = { healthPid: healthPid ?? null, probeLatenciesMs: probes.latenciesMs.join(", ") };
  if (job.pid !== undefined && probes.health === null && probes.allTimedOut) {
    const seconds = probes.latenciesMs.map((ms) => `${(ms / 1000).toFixed(1)} s`).join(", ");
    const message = `${job.manager} pid ${job.pid} is alive but every /health probe on port ${port} timed out (${seconds}); read serve.err.log in the service log directory, then run titan-factory service restart`;
    return verdict("unresponsive", message, job, null, detail);
  }
  if (isRestarting(job)) return restarting(job, probes.health, detail);
  return verdict("stale pid", unansweredWhy(job, port, probes.failed), job, probes.health, detail);
}

/** A unit between processes is not a stale pid: systemd is about to start the next one. */
const isRestarting = (job: Job): boolean => job.activeState === "activating" || job.activeState === "deactivating" || job.subState === "auto-restart";

function restarting(job: Job, health: Record<string, unknown> | null, probeDetail: CheckResult["detail"]): CheckResult {
  const state = [job.activeState, job.subState].filter((part) => part !== undefined && part !== "").join(" ");
  const detail = { ...probeDetail, activeState: job.activeState ?? null, subState: job.subState ?? null, socket: job.socket === "listening" ? "listening" : "absent" };
  return verdict("restarting", `${UNIT_NAME} is restarting (${state}); retry in ${RESTARTING_RETRY_S} s`, job, health, detail);
}

const unansweredWhy = (job: Job, port: number, failedProbes: number): string => {
  const probes = failedProbes > 1 ? ` (${failedProbes} probes failed)` : "";
  return `${job.pid === undefined ? `${job.manager} holds no process` : `${job.manager} pid ${job.pid} does not answer /health on port ${port}${probes}`}; ${RESTART}`;
};

function crashLoop(job: Job, name: string, health: Record<string, unknown> | null): CheckResult {
  const message = `${name} is crash-looping: last exit ${job.lastExit}, ${job.runs} ${job.manager === "systemd" ? "restarts" : "runs"}; read serve.err.log in the service log directory, fix it, then run titan-factory service restart`;
  return verdict("crash loop", message, job, health, { lastExitCode: job.lastExit ?? null, runs: job.runs ?? null });
}

async function judgeRunning(ports: CheckPorts, job: Job, health: Record<string, unknown>): Promise<CheckResult> {
  const running = runningSha(health);
  const target = await newerRestartTarget(ports, running);
  if (target !== undefined) {
    const message = `the server runs build ${running} but the dist a restart loads is build ${target}, which is newer; run titan-factory service restart`;
    return verdict("stale build", message, job, health, { runningBuild: running ?? null, restartTarget: target });
  }
  if (health.github !== "ok") return verdict("GitHub down", `/health answers from pid ${job.pid} but its GitHub check is not ok: ${String(health.github)}; run gh auth status`, job, health, { github: String(health.github) });
  return verdict(null, `ok: /health answers from pid ${job.pid} with github ok`, job, health);
}

async function checkService(ports: CheckPorts, io: ServiceIo, port: number, json: boolean): Promise<number> {
  const result = await diagnoseService(ports, port);
  io.stdout(json ? `${JSON.stringify(result)}\n` : `${result.cause === null ? "" : `${result.cause}: `}${result.message}\n`);
  if (result.ok) return EXIT.OK;
  return result.cause === "restarting" ? EXIT.TEMPFAIL : EXIT.FAILURE;
}

export function registerServiceCheck(service: Command, io: ServiceIo, portsOf: () => CheckPorts, setExit: (code: number) => void): void {
  service
    .command("check")
    .description("exit 0 when /health answers from the launchd or systemd pid with github ok and deploys are not stalled; otherwise one line naming the cause, never changing the service; a stale CLI on PATH (behind the deploy checkout) is named but still exits 0")
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .option("--json", "print cause, pid, health and the cause's details as one JSON object")
    .action(async (opts: { port: number; json?: boolean }) => {
      const ports = portsOf();
      setExit(await runServiceVerb("check", ports, io, () => checkService(ports, io, opts.port, opts.json === true), MANAGED_PLATFORMS));
    });
}
