import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { isProcessAlive, probeHealth } from "@titan-design/daemon";
import { buildSha } from "./build-info.js";
import type { CheckPorts } from "./service-check.js";
import type { CommandResult, ServicePorts } from "./service-control.js";

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

export function systemServicePorts(): ServicePorts {
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    home: homedir(),
    launchctl: async (args) => (await runCommand("launchctl", args)) ?? { code: NOT_FOUND, stdout: "", stderr: "launchctl not found" },
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

/** `ps` reports whole seconds in local time; the C locale keeps the format parseable. */
async function processStartedAt(pid: number): Promise<Date | null> {
  const result = await runCommand("ps", ["-o", "lstart=", "-p", String(pid)], { LC_ALL: "C" });
  const started = new Date(result?.stdout.trim() ?? "");
  return result?.code === 0 && !Number.isNaN(started.getTime()) ? started : null;
}

export function systemCheckPorts(): CheckPorts {
  return { ...systemServicePorts(), isAlive: isProcessAlive, processStartedAt, installedBuildSha: buildSha };
}
