import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { getProcessStartTime, isProcessAlive, probeHealth } from "@titan-design/daemon";
import { distBuildSha } from "./dist-build.js";
import { configPath, loadConfig } from "./config.js";
import type { Listener, PortOwnerReaders, ProcessInfo } from "./port-owner.js";
import type { CheckPorts } from "./service-check.js";
import { inspectIndexLock, nodeLockProbe } from "./stale-lock.js";
import type { CommandResult, ServicePorts } from "./service-control.js";
import type { TickStatusRead } from "./tick-status.js";

const COMMAND_TIMEOUT_MS = 30_000;
const NOT_FOUND = 127;
/** A loaded serve answers /health in 0.5-5 s; the daemon's 500 ms default read that as a dead pid (TP-2417). */
export const SERVICE_CHECK_HEALTH_TIMEOUT_MS = 6_000;

/** Resolves with the exit code instead of rejecting, and with undefined when the binary is not on PATH. */
export function runCommand(file: string, args: readonly string[], env?: Readonly<Record<string, string>>): Promise<CommandResult | undefined> {
  return new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, ...(env ? { env: { ...process.env, ...env } } : {}) }, (error, stdout, stderr) => {
      if (error?.code === "ENOENT") return resolve(undefined);
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr: stderr || error?.message || "" });
    });
  });
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The file a bare `name` runs from `pathVar`, as found and not resolved, so a Homebrew symlink survives an upgrade. */
export function findOnPath(name: string, pathVar: string | undefined): string | undefined {
  const dirs = (pathVar ?? "").split(delimiter).filter((dir) => isAbsolute(dir));
  return dirs.map((dir) => join(dir, name)).find(isExecutableFile);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The one place the label prefix is resolved, from the env the CLI runs under. A config that fails
 * to load yields its error instead of a prefix: runServiceVerb refuses on it, so no verb acts on the
 * default label's job when the configured one may differ. Only `service plist` prints without it.
 */
function configuredLabelPrefix(env: NodeJS.ProcessEnv): Pick<ServicePorts, "labelPrefix" | "configError"> {
  try {
    const labelPrefix = loadConfig(configPath(env)).service?.labelPrefix;
    return labelPrefix === undefined ? {} : { labelPrefix };
  } catch (err) {
    return { configError: err instanceof Error ? err.message : String(err) };
  }
}

/** `ss -p` names the holder as `users:(("MainThread",pid=3571910,fd=27))`, and omits the field for another user's socket. */
export function parseSsListeners(stdout: string): Listener[] {
  return stdout.split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
    const pids = new Set([...line.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])));
    return pids.size === 0 ? [{}] : [...pids].map((pid) => ({ pid }));
  });
}

export const parseCmdline = (raw: string): string[] => (raw === "" ? [] : raw.replace(/\0$/, "").split("\0"));

/** The innermost unit wins: a user service sits under `user@<uid>.service/app.slice/`. */
export function parseCgroupUnit(text: string): string | undefined {
  const path = /^0::(.*)$/m.exec(text)?.[1] ?? "";
  return path.split("/").filter((segment) => segment.endsWith(".service")).at(-1);
}

/** Field 22 of /proc/<pid>/stat, counted after comm, which may itself hold spaces and parentheses. */
export function parseStatStartTime(stat: string): string | undefined {
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

async function readProc(pid: number, file: string): Promise<string | undefined> {
  try {
    return await readFile(`/proc/${pid}/${file}`, "utf8");
  } catch {
    return undefined;
  }
}

async function linuxProcessInfo(pid: number): Promise<ProcessInfo | undefined> {
  const [cmdline, cgroup, stat] = await Promise.all([readProc(pid, "cmdline"), readProc(pid, "cgroup"), readProc(pid, "stat")]);
  if (cmdline === undefined) return undefined;
  const cgroupUnit = cgroup === undefined ? undefined : parseCgroupUnit(cgroup);
  const startedAt = stat === undefined ? undefined : parseStatStartTime(stat);
  return { argv: parseCmdline(cmdline), ...(cgroupUnit ? { cgroupUnit } : {}), ...(startedAt ? { startedAt } : {}) };
}

async function linuxListeners(port: number): Promise<Listener[] | undefined> {
  const listed = await runCommand("ss", ["-Hltnp", "sport", "=", `:${port}`]);
  return listed?.code === 0 ? parseSsListeners(listed.stdout) : undefined;
}

/** lsof exits 1 with no output when nothing listens; runCommand fills an empty stderr with its own message, so stdout decides. */
async function lsofListeners(port: number): Promise<Listener[] | undefined> {
  const listed = await runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  const nothingListens = listed?.code === 1 && listed.stdout.trim() === "";
  if (listed === undefined || (listed.code !== 0 && !nothingListens)) return undefined;
  return listed.stdout.split("\n").filter((line) => /^\d+$/.test(line.trim())).map((line) => ({ pid: Number(line.trim()) }));
}

/** ps joins argv with spaces, so a path holding one fails the identity check and the holder is refused, never signalled. */
async function psProcessInfo(pid: number): Promise<ProcessInfo | undefined> {
  const [command, started] = await Promise.all([runCommand("ps", ["-ww", "-o", "command=", "-p", String(pid)]), runCommand("ps", ["-o", "lstart=", "-p", String(pid)])]);
  if (command?.code !== 0 || command.stdout.trim() === "") return undefined;
  const startedAt = started?.code === 0 ? started.stdout.trim() : "";
  return { argv: command.stdout.trim().split(/\s+/), ...(startedAt ? { startedAt } : {}) };
}

/** A pid that exited between the read and the signal is not an error. */
function signalPid(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ESRCH")) throw err;
  }
}

export function systemPortOwner(platform: NodeJS.Platform): PortOwnerReaders {
  if (platform === "linux") return { listeners: linuxListeners, processInfo: linuxProcessInfo, signal: signalPid };
  return { listeners: lsofListeners, processInfo: psProcessInfo, signal: signalPid };
}

export function systemServicePorts(): ServicePorts {
  return {
    ...configuredLabelPrefix(process.env),
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    home: homedir(),
    ...(process.env.XDG_CONFIG_HOME ? { xdgConfigHome: process.env.XDG_CONFIG_HOME } : {}),
    launchctl: async (args) => (await runCommand("launchctl", args)) ?? { code: NOT_FOUND, stdout: "", stderr: "launchctl not found" },
    systemctl: async (args) => (await runCommand("systemctl", args)) ?? { code: NOT_FOUND, stdout: "", stderr: "systemctl not found" },
    claude: (args, env) => runCommand("claude", args, env),
    isDirectory,
    which: (binary) => findOnPath(binary, process.env.PATH),
    health: (port) => probeHealth(port, { timeoutMs: SERVICE_CHECK_HEALTH_TIMEOUT_MS }),
    mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
    writeFile: (path, text) => writeFileSync(path, text),
    readFile: readIfPresent,
    exists: existsSync,
    remove: (path) => rmSync(path, { force: true }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    portOwner: systemPortOwner(process.platform),
  };
}

/** The file agent-chat's burndown tick writes; AGENT_CHAT_HOME decides where, as it does for agent-chat. */
function tickStatusRead(): TickStatusRead {
  const file = join(process.env.AGENT_CHAT_HOME || join(homedir(), ".agent-chat"), "burndown-status.json");
  return { file, text: readIfPresent(file) };
}

/** A config that fails to load was already refused by runServiceVerb, so here it reads as no seat. */
function configuredHubSeat(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return loadConfig(configPath(env)).shepherd?.hubSeat;
  } catch {
    return undefined;
  }
}

async function gitIn(checkout: string, args: readonly string[]): Promise<CommandResult | undefined> {
  return runCommand("git", ["-C", checkout, ...args]);
}

async function checkoutHasAncestor(checkout: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await gitIn(checkout, ["merge-base", "--is-ancestor", ancestor, descendant]))?.code === 0;
}

/** `checkout` is the service checkout whose index.lock blocks deploys and whose built dist a restart loads. */
export function systemCheckPorts(checkout: string): CheckPorts {
  return {
    ...systemServicePorts(),
    isAlive: isProcessAlive,
    processStartedAt: async (pid) => getProcessStartTime(pid),
    restartTargetSha: async () => distBuildSha(checkout),
    isAncestor: (ancestor, descendant) => checkoutHasAncestor(checkout, ancestor, descendant),
    tickStatus: tickStatusRead,
    indexLock: () => inspectIndexLock(checkout, nodeLockProbe),
    hubSeat: () => configuredHubSeat(process.env),
  };
}
