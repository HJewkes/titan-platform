import { execFile, type ExecFileException } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isProcessAlive } from "@titan-design/daemon";
import { gitChildEnv, setupEnv } from "@titan-design/worktree";
import { errorCode } from "@titan-design/rpc-protocol/narrow";
import { deployRecordPath, parseDeployRecord, type DeployPorts, type DeployRecord } from "./deploy.js";
import { z } from "zod";
import { deployWindowPath } from "./deploy-output.js";
import type { CommandResult } from "./service-control.js";
import { UNAVAILABLE, type Probe, type WatchIntent } from "./deploy-watch-window.js";
import { nodeMorningHoldPorts } from "./morning-deploy-hold.js";
import type { PauseClearPorts } from "./owner-ops/pause-clear.js";
import { systemServicePorts } from "./service-ports.js";

const GIT_TIMEOUT_MS = 120_000;
const PNPM_TIMEOUT_MS = 15 * 60_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const NOT_FOUND = 127;

/** A child with no exit code was ended from outside, so say what ended it. */
function endedBy(error: ExecFileException, timeout: number): string | undefined {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return `output passed ${MAX_OUTPUT_BYTES} bytes`;
  if (error.signal) return `killed by ${error.signal}${error.killed ? ` after the ${timeout / 1000} s timeout` : ""}`;
  return typeof error.code === "number" ? undefined : error.message;
}

/**
 * Resolves with the exit code instead of rejecting; a missing binary exits 127 as a shell would.
 * Both streams are kept: pnpm prints a failing script's output on stdout, leaving stderr empty.
 */
export function runCommand(file: string, args: readonly string[], cwd: string, timeout: number, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { cwd, env, encoding: "utf8", timeout, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      if (error?.code === "ENOENT") return resolve({ code: NOT_FOUND, stdout: "", stderr: `${file} not found` });
      if (!error) return resolve({ code: 0, stdout, stderr });
      const ended = endedBy(error, timeout);
      resolve({ code: typeof error.code === "number" ? error.code : 1, stdout, stderr: ended === undefined ? stderr : `${stderr}\n${file} ${ended}` });
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
    if (errorCode(err) === "EEXIST") return false;
    throw err;
  }
}

function rename(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
}

/**
 * The service checkout only ever holds a reviewed main commit, so its packageManager pin is
 * trusted: without the switch a global pnpm 10 installs a layout every pinned pnpm then purges.
 * With no TTY pnpm's purge prompt exits 0 without installing; pnpm 9 skips that prompt only under CI.
 * Install keeps setupEnv's ignore_scripts, so no dependency lifecycle script runs. Any other step lifts
 * it: pnpm 9 still runs a named script under it but leaves node_modules/.bin off the script's PATH, so
 * the build's `tsup` is not found.
 */
export function deployPnpmEnv(env: NodeJS.ProcessEnv, args: readonly string[]): NodeJS.ProcessEnv {
  const pinned = {
    ...setupEnv(env),
    npm_config_manage_package_manager_versions: "true",
    NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: "true",
    CI: "true",
  };
  return args[0] === "install" ? pinned : { ...pinned, npm_config_ignore_scripts: "false", NPM_CONFIG_IGNORE_SCRIPTS: "false" };
}

/** Statuses a rate limiter or a proxy answers with; they say nothing about whether serve is up. */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([403, 422, 429]);

/** GET `/health`: the body, null on any other failure, or `UNAVAILABLE` when the answer is a rate limit or a refusal to read. */
async function probeServe(port: number, timeoutMs: number): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (UNAVAILABLE_STATUSES.has(res.status)) return UNAVAILABLE;
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function systemDeployPorts(checkout: string): DeployPorts {
  const gitEnv = gitChildEnv(process.env);
  return {
    ...systemServicePorts(),
    pid: process.pid,
    healthWithin: probeServe,
    clone: (remote, dest) => runCommand("git", ["clone", "--branch", "main", "--", remote, dest], dirname(dest), CLONE_TIMEOUT_MS, gitEnv),
    git: (args) => runCommand("git", args, checkout, GIT_TIMEOUT_MS, gitEnv),
    pnpm: (args) => runCommand("pnpm", args, checkout, PNPM_TIMEOUT_MS, deployPnpmEnv(process.env, args)),
    listDirs,
    listFiles: nodeMorningHoldPorts.listFiles,
    copyTree: (from, to) => cpSync(from, to, { recursive: true }),
    removeTree: (path) => rmSync(path, { recursive: true, force: true }),
    createExclusive,
    rename,
    isAlive: isProcessAlive,
  };
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Only the deploy lock and the pause files: serve's console clear needs no checkout, git or pnpm. */
export function systemPauseClearPorts(): PauseClearPorts {
  return { pid: process.pid, exists: existsSync, readFile: readIfPresent, remove: (path) => rmSync(path, { force: true }), createExclusive, rename, isAlive: isProcessAlive };
}

/** The origin URL of `checkout`, the canonical remote a deploy clone defaults to; undefined when it has none. */
export async function originOf(checkout: string): Promise<string | undefined> {
  const result = await runCommand("git", ["remote", "get-url", "origin"], checkout, GIT_TIMEOUT_MS, gitChildEnv(process.env));
  return result.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : undefined;
}

/** What `/health` shows as `lastDeploy`; null before the first deploy. */
export function readLastDeploy(stateDir: string): DeployRecord | null {
  try {
    return parseDeployRecord(readFileSync(deployRecordPath(stateDir), "utf8")) ?? null;
  } catch {
    return null;
  }
}

const WindowRecord = z.object({ sha: z.string(), windowEnd: z.number() });

/** The open or last health watch; an absent or unreadable record reads as none. */
export function readDeployWindow(stateDir: string): WatchIntent | undefined {
  try {
    const parsed = WindowRecord.safeParse(JSON.parse(readFileSync(deployWindowPath(stateDir), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
