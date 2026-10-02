import { execFile } from "node:child_process";
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gitChildEnv, setupEnv } from "@titan-design/worktree";
import { deployRecordPath, parseDeployRecord, type DeployPorts, type DeployRecord } from "./deploy.js";
import type { CommandResult } from "./service-control.js";
import { systemServicePorts } from "./service-ports.js";

const GIT_TIMEOUT_MS = 120_000;
const PNPM_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const NOT_FOUND = 127;

/** Resolves with the exit code instead of rejecting; a missing binary exits 127 as a shell would. */
function run(file: string, args: readonly string[], cwd: string, timeout: number, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { cwd, env, encoding: "utf8", timeout, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      if (error?.code === "ENOENT") return resolve({ code: NOT_FOUND, stdout: "", stderr: `${file} not found` });
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr: stderr || error?.message || "" });
    });
  });
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? [entry.name] : []));
  } catch {
    return [];
  }
}

function createExclusive(path: string, text: string): boolean {
  try {
    writeFileSync(path, text, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** EPERM means the pid exists under another user, which still holds the lock. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function systemDeployPorts(checkout: string): DeployPorts {
  const pnpmEnv = setupEnv(process.env);
  const gitEnv = gitChildEnv(process.env);
  return {
    ...systemServicePorts(),
    pid: process.pid,
    git: (args) => run("git", args, checkout, GIT_TIMEOUT_MS, gitEnv),
    pnpm: (args) => run("pnpm", args, checkout, PNPM_TIMEOUT_MS, pnpmEnv),
    listDirs,
    copyTree: (from, to) => cpSync(from, to, { recursive: true }),
    removeTree: (path) => rmSync(path, { recursive: true, force: true }),
    createExclusive,
    isAlive,
  };
}

/** What `/health` shows as `lastDeploy`; null before the first deploy. */
export function readLastDeploy(stateDir: string): DeployRecord | null {
  try {
    return parseDeployRecord(readFileSync(deployRecordPath(stateDir), "utf8")) ?? null;
  } catch {
    return null;
  }
}
