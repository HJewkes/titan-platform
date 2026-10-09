import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { getProcessStartTime, isProcessAlive, probeHealth } from "@titan-design/daemon";
import { buildSha } from "./build-info.js";
import { configPath, loadConfig } from "./config.js";
import type { CheckPorts } from "./service-check.js";
import { inspectIndexLock, nodeLockProbe } from "./stale-lock.js";
import type { CommandResult, ServicePorts } from "./service-control.js";
import type { TickStatusRead } from "./tick-status.js";

const COMMAND_TIMEOUT_MS = 30_000;
const NOT_FOUND = 127;

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

/** Resolved when the ports are built, from the env the CLI runs under. A malformed config falls back to the default label: `service plist` must print without a readable config, and every verb that needs the config reports its error itself. */
function configuredLabelPrefix(env: NodeJS.ProcessEnv): { labelPrefix?: string } {
  try {
    const labelPrefix = loadConfig(configPath(env)).service?.labelPrefix;
    return labelPrefix === undefined ? {} : { labelPrefix };
  } catch {
    return {};
  }
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
    health: (port) => probeHealth(port),
    mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
    writeFile: (path, text) => writeFileSync(path, text),
    readFile: readIfPresent,
    exists: existsSync,
    remove: (path) => rmSync(path, { force: true }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  };
}

/** The file agent-chat's burndown tick writes; AGENT_CHAT_HOME decides where, as it does for agent-chat. */
function tickStatusRead(): TickStatusRead {
  const file = join(process.env.AGENT_CHAT_HOME || join(homedir(), ".agent-chat"), "burndown-status.json");
  return { file, text: readIfPresent(file) };
}

/** `checkout` is the service checkout whose index.lock blocks deploys. */
export function systemCheckPorts(checkout: string): CheckPorts {
  return {
    ...systemServicePorts(),
    isAlive: isProcessAlive,
    processStartedAt: async (pid) => getProcessStartTime(pid),
    installedBuildSha: buildSha,
    tickStatus: tickStatusRead,
    indexLock: () => inspectIndexLock(checkout, nodeLockProbe),
  };
}
