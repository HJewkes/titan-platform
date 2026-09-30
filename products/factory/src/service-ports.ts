import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { probeHealth } from "@titan-design/daemon";
import type { CommandResult, ServicePorts } from "./service-control.js";

const COMMAND_TIMEOUT_MS = 30_000;
const NOT_FOUND = 127;

/** Resolves with the exit code instead of rejecting, and with undefined when the binary is not on PATH. */
export function runCommand(file: string, args: readonly string[]): Promise<CommandResult | undefined> {
  return new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error?.code === "ENOENT") return resolve(undefined);
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr: stderr || error?.message || "" });
    });
  });
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
    claude: (args) => runCommand("claude", args),
    health: (port) => probeHealth(port),
    mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
    writeFile: (path, text) => writeFileSync(path, text),
    readFile: readIfPresent,
    exists: existsSync,
    remove: (path) => rmSync(path, { force: true }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
