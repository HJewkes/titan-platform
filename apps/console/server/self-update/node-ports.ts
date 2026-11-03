import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { withdrawMatching } from "@titan-design/owner-queue/withdraw";
import { z } from "zod";
import { UPDATE_ALARM_ASKER, UPDATE_ALARM_KEY } from "./alarm.js";
import { releaseCli, withTail, type NodeRun } from "./release-smoke.js";
import { writeShim } from "./shim.js";
import type { CommandResult, UpdatePorts } from "./update.js";

const COMMAND_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT = 64 * 1024 * 1024;
const POLL_MS = 1_000;
const HEALTH_TIMEOUT_MS = 2_000;
/** A cold start reads the session graph and the upstreams; the factory's deployer waits about as long. */
const SERVE_WAIT_MS = 60_000;
/** The smoke verb's own wait plus its spare port, page check and teardown. */
const SMOKE_RUN_TIMEOUT_MS = SERVE_WAIT_MS + 60_000;
const KILL_GRACE_MS = 10_000;
const STDERR_KEEP_CHARS = 16 * 1024;

function run(file: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { cwd, env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout, stderr: error !== null && stderr === "" ? error.message : stderr });
    });
  });
}

const healthBuild = z.object({ build: z.object({ sha: z.string() }).nullish() });

const errnoCode = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** null when the console answered with no build sha (a build from before the stamp), undefined when it did not answer. */
async function healthSha(port: number): Promise<string | null | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), redirect: "error" });
    if (!response.ok) return undefined;
    const body = healthBuild.safeParse(await response.json());
    return body.success ? (body.data.build?.sha ?? null) : null;
  } catch {
    return undefined;
  }
}

async function pollSha(port: number, want: string, waitMs: number = SERVE_WAIT_MS, stop?: AbortSignal): Promise<string | null | undefined> {
  const deadline = Date.now() + waitMs;
  let last: string | null | undefined;
  while (Date.now() < deadline && stop?.aborted !== true) {
    last = await healthSha(port);
    if (last === want) return last;
    await sleep(POLL_MS);
  }
  return last;
}

function sparePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no spare port"))));
    });
  });
}

/**
 * Only the port and a scratch state dir: no LAN listener, no owner writes, no pid file shared with the served console.
 * The story origin is off: its default port is the served console's, and a bind failure stops the smoke build before /health.
 */
export function smokeEnv(port: number, stateDir: string): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(([key]) => !key.startsWith("TITAN_CONSOLE_"));
  return { ...Object.fromEntries(kept), TITAN_CONSOLE_PORT: String(port), TITAN_CONSOLE_STORY_PORT: "0", TITAN_CONSOLE_STATE: stateDir };
}

async function pageAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), redirect: "error" });
    // The daemon answers 200 with its placeholder page when dist/index.html is missing.
    return response.status === 200 && !(await response.text()).includes("<title>Not built</title>");
  } catch {
    return false;
  }
}

/** Keeps only the end of a stream, which is where a crash says why. */
function streamTail(stream: Readable | null): () => string {
  let text = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    text = `${text}${chunk}`.slice(-STDERR_KEEP_CHARS);
  });
  return () => text;
}

interface SmokeOptions {
  waitMs?: number;
  /** Ends the wait early, as SIGTERM does for the smoke verb, so its daemon is still stopped. */
  signal?: AbortSignal;
}

/** Undefined once the release's bin answers /health as `sha` and serves its page; else why not, with the end of its stderr. */
export async function smokeRelease(release: string, sha: string, options: SmokeOptions = {}): Promise<string | undefined> {
  const port = await sparePort();
  const stateDir = mkdtempSync(path.join(tmpdir(), "titan-console-smoke-"));
  const child = spawn(process.execPath, [releaseCli(release)], { env: smokeEnv(port, stateDir), stdio: ["ignore", "ignore", "pipe"] });
  const stderr = streamTail(child.stderr);
  const closed = new AbortController();
  child.once("close", () => closed.abort());
  const stop = options.signal === undefined ? closed.signal : AbortSignal.any([closed.signal, options.signal]);
  try {
    const answered = await pollSha(port, sha, options.waitMs, stop);
    if (answered !== sha) return withTail(`the new build on spare port ${port} ${notAnswered(child, answered, sha)}`, stderr());
    return (await pageAnswers(port)) ? undefined : withTail(`the new build on spare port ${port} did not serve its page at /`, stderr());
  } finally {
    child.kill("SIGTERM");
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function notAnswered(child: ChildProcess, answered: string | null | undefined, sha: string): string {
  if (child.exitCode !== null || child.signalCode !== null) return `exited (${child.signalCode ?? `code ${child.exitCode}`}) before answering /health as ${sha}`;
  return `answered /health ${answered === undefined ? "with nothing" : `as ${answered ?? "no build sha"}`}, not ${sha}`;
}

/** SIGTERM at the deadline lets the smoke verb stop its own daemon; SIGKILL follows for one that does not exit. */
function runNode(script: string, args: readonly string[], timeoutMs: number = SMOKE_RUN_TIMEOUT_MS): Promise<NodeRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = streamTail(child.stdout);
    const stderr = streamTail(child.stderr);
    let timedOut = false;
    const term = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const kill = setTimeout(() => child.kill("SIGKILL"), timeoutMs + KILL_GRACE_MS);
    const finish = (code: number, why = ""): void => {
      clearTimeout(term);
      clearTimeout(kill);
      resolve({ code, stdout: stdout(), stderr: `${stderr()}${why}`, timedOut });
    };
    child.once("error", (error) => finish(1, error.message));
    child.once("close", (code) => finish(code ?? 1));
  });
}

function swapLink(link: string, target: string): void {
  const fresh = `${link}.${process.pid}.new`;
  rmSync(fresh, { force: true });
  symlinkSync(target, fresh);
  renameSync(fresh, link);
}

function readLink(link: string): string | undefined {
  try {
    return lstatSync(link).isSymbolicLink() ? realpathSync(link) : undefined;
  } catch {
    return undefined;
  }
}

function createExclusive(file: string, text: string): boolean {
  try {
    writeFileSync(file, text, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

function fileSize(file: string): number | undefined {
  try {
    return statSync(file).size;
  } catch {
    return undefined;
  }
}

/** syncfs(2) on the release's filesystem: one call flushes the whole worktree without walking node_modules file by file. */
async function syncFs(dir: string): Promise<string | undefined> {
  const synced = await run("sync", ["-f", dir]);
  return synced.code === 0 ? undefined : synced.stderr.trim() || `exit ${synced.code}`;
}

const readFile = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, "utf8") : undefined);
const listDirs = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : []);

/** The production ports; `inboxDir` is the console's own owner-queue spool, the one the factory's deploy incident writes. */
export function nodeUpdatePorts(inboxDir: string): UpdatePorts {
  return {
    pid: process.pid,
    git: (cwd, args) => run("git", args, cwd),
    pnpm: (cwd, args) => run("pnpm", args, cwd),
    systemctl: (args) => run("systemctl", args),
    readLink,
    swapLink,
    exists: existsSync,
    listDirs,
    mkdir: (dir) => void mkdirSync(dir, { recursive: true, mode: 0o700 }),
    writeFile: (file, text) => writeFileSync(file, text, { mode: 0o600 }),
    writeShim,
    syncFs,
    fileSize,
    readFile,
    remove: (file) => rmSync(file, { force: true }),
    createExclusive,
    isAlive,
    smoke: (release, sha) => smokeRelease(release, sha),
    runNode: (script, args) => runNode(script, args),
    servedSha: (port, want) => pollSha(port, want),
    alarm: async (deposit) => void (await writeDeposit(inboxDir, deposit)),
    resolveAlarms: async () => (await withdrawMatching(inboxDir, { asker: UPDATE_ALARM_ASKER, actor: UPDATE_ALARM_ASKER, keys: [UPDATE_ALARM_KEY], reason: "resolved" })).length,
    log: (line) => console.log(line),
    now: Date.now,
  };
}
