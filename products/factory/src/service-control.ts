import { dirname, join } from "node:path";
import { plistPath, renderPlist, SERVICE_LABEL, type PlistOptions } from "./service.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Every effect a service verb has on the machine; tests pass fakes, so none of them reaches launchd. */
export interface ServicePorts {
  platform: NodeJS.Platform;
  uid: number;
  home: string;
  launchctl: (args: readonly string[]) => Promise<CommandResult>;
  /** Resolves undefined when no `claude` binary is on PATH. */
  claude: (args: readonly string[]) => Promise<CommandResult | undefined>;
  /** The absolute file a bare binary name runs on this machine, or undefined when it is not on PATH. */
  which: (binary: string) => string | undefined;
  /** The `/health` body, or null when nothing answers. */
  health: (port: number) => Promise<Record<string, unknown> | null>;
  mkdir: (dir: string) => void;
  writeFile: (path: string, text: string) => void;
  readFile: (path: string) => string | undefined;
  exists: (path: string) => boolean;
  remove: (path: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export interface ServiceIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface InstallOptions {
  plist: PlistOptions;
  /** The port `/health` is polled on; the plist carries its own copy. */
  port: number;
  mcp: boolean;
  /** Binaries the plist's PATH could not cover. */
  missing: readonly string[];
}

const POLL_MS = 250;
const HEALTH_POLLS = 120;
const GITHUB_SETTLE_POLLS = 48;
const GITHUB_CHECKING = "checking";
const UNLOAD_POLLS = 40;
const LOG_TAIL_LINES = 20;
const FAILURE = 1;

const serviceTarget = (ports: ServicePorts): string => `gui/${ports.uid}/${SERVICE_LABEL}`;
const detail = (result: CommandResult): string => (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`);

function fail(io: ServiceIo, message: string): number {
  io.stderr(`error: ${message}\n`);
  return FAILURE;
}

/** launchd exists only on macOS, so every verb that talks to it stops here elsewhere. */
export async function runServiceVerb(verb: string, ports: ServicePorts, io: ServiceIo, run: (ports: ServicePorts) => Promise<number>): Promise<number> {
  if (ports.platform !== "darwin") return fail(io, `titan-factory service ${verb} needs launchd, which only macOS has (this is ${ports.platform})`);
  return run(ports);
}

interface JobState {
  loaded: boolean;
  /** Absent while launchd holds the job without a running process. */
  pid?: number;
}

async function jobState(ports: ServicePorts): Promise<JobState> {
  const printed = await ports.launchctl(["print", serviceTarget(ports)]);
  if (printed.code !== 0) return { loaded: false };
  const pid = /^\s*pid = (\d+)$/m.exec(printed.stdout)?.[1];
  return { loaded: true, ...(pid === undefined ? {} : { pid: Number(pid) }) };
}

/** Bootout returns before launchd has let go of the label, and a bootstrap in that window fails with error 5. */
async function bootoutIfLoaded(ports: ServicePorts, io: ServiceIo, job: JobState): Promise<boolean> {
  if (!job.loaded) return true;
  const bootout = await ports.launchctl(["bootout", serviceTarget(ports)]);
  for (let poll = 0; poll < UNLOAD_POLLS; poll++) {
    if (!(await jobState(ports)).loaded) return true;
    await ports.sleep(POLL_MS);
  }
  fail(io, `${SERVICE_LABEL} is still loaded after launchctl bootout: ${detail(bootout)}`);
  return false;
}

type Probe = { state: "up" } | { state: "waiting" | "broken"; why: string };

function githubProbe(health: Record<string, unknown>, port: number): Probe {
  if (health.github === "ok") return { state: "up" };
  if (health.github === GITHUB_CHECKING) return { state: "waiting", why: `titan-factory serve on port ${port} did not finish its GitHub check` };
  return { state: "broken", why: `titan-factory serve answers on port ${port} but its GitHub check failed: ${String(health.github)}` };
}

/** Health must come from launchd's own process: another serve on the port answers ok while the job crash-loops. */
async function probeJob(ports: ServicePorts, port: number): Promise<Probe> {
  const health = await ports.health(port);
  if (health?.ok !== true) return { state: "waiting", why: `titan-factory serve did not answer /health on port ${port}` };
  const { pid } = await jobState(ports);
  if (pid !== undefined && health.pid === pid) return githubProbe(health, port);
  return { state: "waiting", why: `port ${port} is answered by pid ${String(health.pid)}, not by ${SERVICE_LABEL}; stop that process, then run titan-factory service restart` };
}

/** A failed GitHub check ends the wait at once: serve caches it for a minute, so polling on cannot change it. */
async function awaitHealthy(ports: ServicePorts, io: ServiceIo, port: number, logDir: string): Promise<boolean> {
  let last: Probe = { state: "up" };
  for (let poll = 0; poll < HEALTH_POLLS; poll++) {
    last = await probeJob(ports, port);
    if (last.state !== "waiting") break;
    await ports.sleep(POLL_MS);
  }
  if (last.state === "up") return true;
  if (last.state === "broken") fail(io, last.why);
  else fail(io, `${last.why} within ${(HEALTH_POLLS * POLL_MS) / 1000} s\n${errorLogTail(ports, logDir)}`);
  return false;
}

function errorLogTail(ports: ServicePorts, logDir: string): string {
  const file = join(logDir, "serve.err.log");
  const text = ports.readFile(file)?.trimEnd() ?? "";
  return text === "" ? `${file} is empty or missing` : `--- tail of ${file}\n${text.split("\n").slice(-LOG_TAIL_LINES).join("\n")}`;
}

export async function installService(ports: ServicePorts, io: ServiceIo, options: InstallOptions): Promise<number> {
  const file = plistPath(ports.home);
  if (options.missing.includes("gh")) return fail(io, "gh is not on PATH, and titan-factory serve cannot reach GitHub without it; install gh, then rerun");
  if (!(await bootoutIfLoaded(ports, io, await jobState(ports)))) return FAILURE;
  ports.mkdir(options.plist.logDir);
  ports.mkdir(dirname(file));
  ports.writeFile(file, renderPlist(options.plist));
  const bootstrap = await ports.launchctl(["bootstrap", `gui/${ports.uid}`, file]);
  if (bootstrap.code !== 0) return fail(io, `launchctl bootstrap failed: ${detail(bootstrap)}`);
  if (!(await awaitHealthy(ports, io, options.port, options.plist.logDir))) return FAILURE;
  io.stdout(`installed ${SERVICE_LABEL} from ${file}; /health answers on port ${options.port}\n`);
  if (options.mcp) await registerMcp(ports, io, options.port);
  return 0;
}

/** Registration is a convenience on top of a working service, so no outcome here fails the install. */
async function registerMcp(ports: ServicePorts, io: ServiceIo, port: number): Promise<void> {
  const args = ["mcp", "add", "--transport", "http", "--scope", "user", "titan-factory", `http://127.0.0.1:${port}/mcp`];
  const added = await ports.claude(args);
  if (added?.code === 0) return io.stdout("registered titan-factory with claude at user scope\n");
  if (added && /already exists/i.test(added.stdout + added.stderr)) return io.stdout("titan-factory is already registered with claude\n");
  const why = added ? `claude mcp add failed: ${detail(added)}` : "no claude binary on PATH";
  io.stderr(`${why}; to register the MCP endpoint, run:\n  claude ${args.join(" ")}\n`);
}

export async function uninstallService(ports: ServicePorts, io: ServiceIo): Promise<number> {
  const file = plistPath(ports.home);
  const job = await jobState(ports);
  if (!(await bootoutIfLoaded(ports, io, job))) return FAILURE;
  const written = ports.exists(file);
  ports.remove(file);
  io.stdout(job.loaded || written ? `uninstalled ${SERVICE_LABEL}; removed ${file}\n` : `${SERVICE_LABEL} was not installed\n`);
  return 0;
}

export async function serviceStatus(ports: ServicePorts, io: ServiceIo, port: number): Promise<number> {
  const job = await jobState(ports);
  const health = await settledHealth(ports, port);
  const healthy = health?.ok === true;
  const running = job.pid === undefined ? "no process" : `pid ${job.pid}`;
  io.stdout(`${SERVICE_LABEL}: ${job.loaded ? `loaded, ${running}` : "not loaded"}\n`);
  io.stdout(`health: ${healthy ? healthSummary(health, port) : `no answer on port ${port}`}\n`);
  if (!healthy) return FAILURE;
  return health.github === "ok" ? 0 : fail(io, `/health answers on port ${port} but its GitHub check is not ok: ${String(health.github)}`);
}

/** serve reports `checking` until its first gh probe lands, within its 10 s timeout. */
async function settledHealth(ports: ServicePorts, port: number): Promise<Record<string, unknown> | null> {
  for (let poll = 0; poll < GITHUB_SETTLE_POLLS; poll++) {
    const health = await ports.health(port);
    if (health?.github !== GITHUB_CHECKING) return health;
    await ports.sleep(POLL_MS);
  }
  return ports.health(port);
}

function healthSummary(health: Record<string, unknown>, port: number): string {
  const fields = ["pid", "version", "github", "pendingGates"].flatMap((key) => {
    const value = health[key];
    return typeof value === "string" || typeof value === "number" ? [`${key} ${value}`] : [];
  });
  return `ok on port ${port}${fields.length > 0 ? ` (${fields.join(", ")})` : ""}`;
}

export async function restartService(ports: ServicePorts, io: ServiceIo, port: number, logDir: string): Promise<number> {
  const kickstart = await ports.launchctl(["kickstart", "-k", serviceTarget(ports)]);
  if (kickstart.code !== 0) return fail(io, `launchctl kickstart failed: ${detail(kickstart)}; titan-factory service install loads the job`);
  if (!(await awaitHealthy(ports, io, port, logDir))) return FAILURE;
  io.stdout(`restarted ${SERVICE_LABEL}; /health answers on port ${port}\n`);
  return 0;
}
