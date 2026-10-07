import { dirname, join, resolve } from "node:path";
import { DIRTY_SUFFIX, PROBE_PENDING } from "./build-info.js";
import { drainForRestart, type DrainOptions } from "./restart-drain.js";
import { plistPath, renderPlist, renderUnit, SERVICE_LABEL, UNIT_NAME, unitPath, type PlistOptions } from "./service.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Every effect a service verb has on the machine; tests pass fakes, so none of them reaches launchd or systemd. */
export interface ServicePorts {
  /** `linux` drives a systemd --user unit, every other platform a launchd job. */
  platform: NodeJS.Platform;
  uid: number;
  home: string;
  xdgConfigHome?: string;
  launchctl: (args: readonly string[]) => Promise<CommandResult>;
  systemctl: (args: readonly string[]) => Promise<CommandResult>;
  /** Resolves undefined when no `claude` binary is on PATH. */
  claude: (args: readonly string[], env?: Readonly<Record<string, string>>) => Promise<CommandResult | undefined>;
  isDirectory: (path: string) => boolean;
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
  now: () => number;
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
  /** Claude config dirs to register in; empty means the caller's own profile. */
  claudeConfigDirs: readonly string[];
  /** The CLAUDE_CONFIG_DIR the caller runs under, when set. */
  callerConfigDir?: string;
  /** Binaries the plist's PATH could not cover. */
  missing: readonly string[];
  /** Print the file and the commands install would run, and change nothing. */
  dryRun?: boolean;
}

const POLL_MS = 250;
const HEALTH_POLLS = 120;
const GITHUB_SETTLE_POLLS = 48;
const UNLOAD_POLLS = 40;
const LOG_TAIL_LINES = 20;
const FAILURE = 1;

const serviceTarget = (ports: ServicePorts): string => `gui/${ports.uid}/${SERVICE_LABEL}`;
const detail = (result: CommandResult): string => (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`);
const isSystemd = (ports: ServicePorts): boolean => ports.platform === "linux";
const serviceName = (ports: ServicePorts): string => (isSystemd(ports) ? UNIT_NAME : SERVICE_LABEL);
const serviceFile = (ports: ServicePorts): string => (isSystemd(ports) ? unitPath(ports.home, ports.xdgConfigHome) : plistPath(ports.home));
export const renderServiceFile = (ports: ServicePorts, options: PlistOptions): string => (isSystemd(ports) ? renderUnit(options) : renderPlist(options));

function fail(io: ServiceIo, message: string): number {
  io.stderr(`error: ${message}\n`);
  return FAILURE;
}

/** The platforms whose service manager the service verbs drive: launchd on macOS, a systemd --user unit on Linux. */
export const MANAGED_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];

/** launchd exists only on macOS and systemd only on Linux, so a verb stops here on any platform it does not drive. */
export async function runServiceVerb(
  verb: string,
  ports: ServicePorts,
  io: ServiceIo,
  run: (ports: ServicePorts) => Promise<number>,
  platforms: readonly NodeJS.Platform[] = ["darwin"],
): Promise<number> {
  if (platforms.includes(ports.platform)) return run(ports);
  const needs = platforms.includes("linux") ? "launchd (macOS) or systemd (Linux)" : "launchd, which only macOS has";
  return fail(io, `titan-factory service ${verb} needs ${needs} (this is ${ports.platform})`);
}

interface JobState {
  loaded: boolean;
  /** Absent while launchd holds the job without a running process. */
  pid?: number;
  /** systemd's `ActiveState (SubState)`; launchd has no equivalent. */
  state?: string;
}

/** A unit counts as loaded once systemd has a unit file for it and it is not inactive, so a failed unit is still restarted on install. */
async function unitState(ports: ServicePorts): Promise<JobState> {
  const unit = await ports.systemctl(["--user", "show", UNIT_NAME, "--property=LoadState,ActiveState,SubState,MainPID"]);
  const value = (key: string): string => new RegExp(`^${key}=(.*)$`, "m").exec(unit.stdout)?.[1] ?? "";
  if (unit.code !== 0 || value("LoadState") !== "loaded") return { loaded: false };
  const pid = Number(value("MainPID"));
  return { loaded: value("ActiveState") !== "inactive", state: `${value("ActiveState")} (${value("SubState")})`, ...(pid > 0 ? { pid } : {}) };
}

async function jobState(ports: ServicePorts): Promise<JobState> {
  if (isSystemd(ports)) return unitState(ports);
  const printed = await ports.launchctl(["print", serviceTarget(ports)]);
  if (printed.code !== 0) return { loaded: false };
  const pid = /^\s*pid = (\d+)$/m.exec(printed.stdout)?.[1];
  return { loaded: true, ...(pid === undefined ? {} : { pid: Number(pid) }) };
}

/** Bootout returns before launchd has let go of the label, and a bootstrap in that window fails with error 5. systemd restarts in place instead. */
async function bootoutIfLoaded(ports: ServicePorts, io: ServiceIo, job: JobState): Promise<boolean> {
  if (!job.loaded || isSystemd(ports)) return true;
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
  if (health.github === PROBE_PENDING) return { state: "waiting", why: `titan-factory serve on port ${port} did not finish its GitHub check` };
  return { state: "broken", why: `titan-factory serve answers on port ${port} but its GitHub check failed: ${String(health.github)}` };
}

/** Health must come from launchd's own process: another serve on the port answers ok while the job crash-loops. */
async function probeJob(ports: ServicePorts, port: number): Promise<Probe> {
  const health = await ports.health(port);
  if (health?.ok !== true) return { state: "waiting", why: `titan-factory serve did not answer /health on port ${port}` };
  const { pid } = await jobState(ports);
  if (pid !== undefined && health.pid === pid) return githubProbe(health, port);
  return { state: "waiting", why: `port ${port} is answered by pid ${String(health.pid)}, not by ${serviceName(ports)}; stop that process, then run titan-factory service restart` };
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
  else fail(io, `${last.why} within ${(HEALTH_POLLS * POLL_MS) / 1000} s\n${errorLogPointer(ports, logDir)}`);
  return false;
}

/** Points at the log without quoting it: a post-merge chore that runs `service deploy` stores this output, and the log holds error text. */
function errorLogPointer(ports: ServicePorts, logDir: string): string {
  const file = join(logDir, "serve.err.log");
  const text = ports.readFile(file)?.trimEnd() ?? "";
  return text === "" ? `${file} is empty or missing` : `see the last ${LOG_TAIL_LINES} lines of ${file}: tail -n ${LOG_TAIL_LINES} ${file}`;
}

interface ServiceCommand {
  tool: "launchctl" | "systemctl";
  args: string[];
}

const systemctl = (...args: string[]): ServiceCommand => ({ tool: "systemctl", args: ["--user", ...args] });
const shown = ({ tool, args }: ServiceCommand): string => `${tool} ${args.join(" ")}`;

/** `enable --now` starts a stopped unit but leaves a running one on its old unit text, so a loaded unit is restarted too. */
function loadCommands(ports: ServicePorts, file: string, job: JobState): ServiceCommand[] {
  if (!isSystemd(ports)) return [{ tool: "launchctl", args: ["bootstrap", `gui/${ports.uid}`, file] }];
  return [systemctl("daemon-reload"), systemctl("enable", "--now", UNIT_NAME), ...(job.loaded ? [systemctl("restart", UNIT_NAME)] : [])];
}

async function runCommands(ports: ServicePorts, commands: readonly ServiceCommand[]): Promise<string | undefined> {
  for (const command of commands) {
    const result = await ports[command.tool](command.args);
    if (result.code !== 0) return `${command.tool} ${command.args.find((arg) => !arg.startsWith("--"))} failed: ${detail(result)}`;
  }
  return undefined;
}

function preflight(ports: ServicePorts, options: InstallOptions): string | undefined {
  if (options.missing.includes("gh")) return "gh is not on PATH, and titan-factory serve cannot reach GitHub without it; install gh, then rerun";
  const notDir = options.claudeConfigDirs.find((dir) => !ports.isDirectory(resolve(dir)));
  return notDir === undefined ? undefined : `--claude-config-dir ${notDir} is not a directory`;
}

function printInstallPlan(ports: ServicePorts, io: ServiceIo, file: string, job: JobState, plist: PlistOptions): number {
  const unload = job.loaded && !isSystemd(ports) ? [`launchctl bootout ${serviceTarget(ports)}`] : [];
  const commands = [...unload, ...loadCommands(ports, file, job).map(shown)];
  io.stdout(`dry run: would write ${file}:\n${renderServiceFile(ports, plist)}then run:\n${commands.map((line) => `  ${line}\n`).join("")}`);
  return 0;
}

export async function installService(ports: ServicePorts, io: ServiceIo, options: InstallOptions): Promise<number> {
  const file = serviceFile(ports);
  const refused = preflight(ports, options);
  if (refused !== undefined) return fail(io, refused);
  const job = await jobState(ports);
  if (options.dryRun) return printInstallPlan(ports, io, file, job, options.plist);
  if (!(await bootoutIfLoaded(ports, io, job))) return FAILURE;
  ports.mkdir(options.plist.logDir);
  ports.mkdir(dirname(file));
  ports.writeFile(file, renderServiceFile(ports, options.plist));
  const loadFailure = await runCommands(ports, loadCommands(ports, file, job));
  if (loadFailure !== undefined) return fail(io, loadFailure);
  if (!(await awaitHealthy(ports, io, options.port, options.plist.logDir))) return FAILURE;
  io.stdout(`installed ${serviceName(ports)} from ${file}; /health answers on port ${options.port}\n`);
  if (options.mcp) await registerMcpEverywhere(ports, io, options);
  return 0;
}

async function registerMcpEverywhere(ports: ServicePorts, io: ServiceIo, options: InstallOptions): Promise<void> {
  const dirs = options.claudeConfigDirs.map((dir) => resolve(dir));
  if (dirs.length === 0) return registerMcp(ports, io, options.port, options.callerConfigDir);
  for (const dir of dirs) await registerMcp(ports, io, options.port, dir);
}

/** Registration is a convenience on top of a working service, so no outcome here fails the install. */
async function registerMcp(ports: ServicePorts, io: ServiceIo, port: number, configDir: string | undefined): Promise<void> {
  const args = ["mcp", "add", "--transport", "http", "--scope", "user", "titan-factory", `http://127.0.0.1:${port}/mcp`];
  const file = join(configDir ?? ports.home, ".claude.json");
  const added = await ports.claude(args, configDir === undefined ? undefined : { CLAUDE_CONFIG_DIR: configDir });
  if (added?.code === 0) return io.stdout(`registered titan-factory with claude at user scope in ${file}\n`);
  if (added && /already exists/i.test(added.stdout + added.stderr)) return io.stdout(`titan-factory is already registered with claude in ${file}\n`);
  const why = added ? `claude mcp add failed: ${detail(added)}` : "no claude binary on PATH";
  const prefix = configDir === undefined ? "" : `CLAUDE_CONFIG_DIR=${configDir} `;
  io.stderr(`${why}; to register the MCP endpoint in ${file}, run:\n  ${prefix}claude ${args.join(" ")}\n`);
}

export async function uninstallService(ports: ServicePorts, io: ServiceIo): Promise<number> {
  if (isSystemd(ports)) return uninstallUnit(ports, io);
  const file = plistPath(ports.home);
  const job = await jobState(ports);
  if (!(await bootoutIfLoaded(ports, io, job))) return FAILURE;
  const written = ports.exists(file);
  ports.remove(file);
  io.stdout(job.loaded || written ? `uninstalled ${SERVICE_LABEL}; removed ${file}\n` : `${SERVICE_LABEL} was not installed\n`);
  return 0;
}

/** systemd still lists a unit whose file is gone until the next daemon-reload. */
async function uninstallUnit(ports: ServicePorts, io: ServiceIo): Promise<number> {
  const file = serviceFile(ports);
  const known = (await unitState(ports)).state !== undefined || ports.exists(file);
  if (!known) {
    io.stdout(`${UNIT_NAME} was not installed\n`);
    return 0;
  }
  const failure = await runCommands(ports, [systemctl("disable", "--now", UNIT_NAME)]);
  if (failure !== undefined) return fail(io, failure);
  ports.remove(file);
  const reloadFailure = await runCommands(ports, [systemctl("daemon-reload")]);
  if (reloadFailure !== undefined) return fail(io, reloadFailure);
  io.stdout(`uninstalled ${UNIT_NAME}; removed ${file}\n`);
  return 0;
}

export async function serviceStatus(ports: ServicePorts, io: ServiceIo, port: number): Promise<number> {
  const job = await jobState(ports);
  const health = await settledHealth(ports, port);
  const healthy = health?.ok === true;
  const running = job.pid === undefined ? "no process" : `pid ${job.pid}`;
  const shownState = job.state ?? (job.loaded ? "loaded" : undefined);
  io.stdout(`${serviceName(ports)}: ${shownState === undefined ? "not loaded" : `${shownState}, ${running}`}\n`);
  io.stdout(`health: ${healthy ? healthSummary(health, port) : `no answer on port ${port}`}\n`);
  if (!healthy) return FAILURE;
  return health.github === "ok" ? 0 : fail(io, `/health answers on port ${port} but its GitHub check is not ok: ${String(health.github)}`);
}

/** serve reports `checking` until its first gh probe lands, within its 10 s timeout. */
export async function settledHealth(ports: ServicePorts, port: number): Promise<Record<string, unknown> | null> {
  for (let poll = 0; poll < GITHUB_SETTLE_POLLS; poll++) {
    const health = await ports.health(port);
    if (health?.github !== PROBE_PENDING) return health;
    await ports.sleep(POLL_MS);
  }
  return ports.health(port);
}

function healthSummary(health: Record<string, unknown>, port: number): string {
  const fields = ["pid", "version", "github", "pendingGates"].flatMap((key) => {
    const value = health[key];
    return typeof value === "string" || typeof value === "number" ? [`${key} ${value}`] : [];
  });
  const build = buildSummary(health.build);
  if (build) fields.push(build);
  return `ok on port ${port}${fields.length > 0 ? ` (${fields.join(", ")})` : ""}`;
}

function buildSummary(build: unknown): string | undefined {
  if (typeof build !== "object" || build === null) return undefined;
  const { sha, behindMain } = build as Record<string, unknown>;
  if (typeof sha !== "string") return undefined;
  const behind = typeof behindMain === "number" ? `${behindMain} behind main` : `behind main: ${String(behindMain)}`;
  return `build ${sha.slice(0, 12)}${sha.endsWith(DIRTY_SUFFIX) ? DIRTY_SUFFIX : ""}, ${behind}`;
}

export type RestartDrain = Omit<DrainOptions, "port">;

export async function restartService(ports: ServicePorts, io: ServiceIo, port: number, logDir: string, drain: RestartDrain): Promise<number> {
  const drained = await drainForRestart(ports, io.stdout, { ...drain, port });
  if (!drained.proceed) return fail(io, drained.why);
  const restart: ServiceCommand = isSystemd(ports) ? systemctl("restart", UNIT_NAME) : { tool: "launchctl", args: ["kickstart", "-k", serviceTarget(ports)] };
  const failure = await runCommands(ports, [restart]);
  if (failure !== undefined) return fail(io, `${failure}; titan-factory service install loads the job`);
  if (!(await awaitHealthy(ports, io, port, logDir))) return FAILURE;
  io.stdout(`restarted ${serviceName(ports)}; /health answers on port ${port}\n`);
  return 0;
}
