import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import type { CommandResult, UpdatePorts } from "./update.js";

const COMMAND_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT = 64 * 1024 * 1024;
const POLL_MS = 1_000;
const HEALTH_TIMEOUT_MS = 2_000;
/** A cold start reads the session graph and the upstreams; the factory's deployer waits about as long. */
export const SERVE_WAIT_MS = 60_000;

function run(file: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { cwd, env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout, stderr: error !== null && stderr === "" ? error.message : stderr });
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** null when the console answered with no build sha (a build from before the stamp), undefined when it did not answer. */
async function healthSha(port: number): Promise<string | null | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), redirect: "error" });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { build?: { sha?: unknown } | null };
    return typeof body.build?.sha === "string" ? body.build.sha : null;
  } catch {
    return undefined;
  }
}

export async function pollSha(port: number, want: string, waitMs: number = SERVE_WAIT_MS): Promise<string | null | undefined> {
  const deadline = Date.now() + waitMs;
  let last: string | null | undefined;
  while (Date.now() < deadline) {
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

/** Only the port and a scratch state dir: no LAN listener, no owner writes, no pid file shared with the served console. */
function smokeEnv(port: number, stateDir: string): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(([key]) => !key.startsWith("TITAN_CONSOLE_"));
  return { ...Object.fromEntries(kept), TITAN_CONSOLE_PORT: String(port), TITAN_CONSOLE_STATE: stateDir };
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

export async function smokeRelease(release: string, sha: string): Promise<string | undefined> {
  const port = await sparePort();
  const stateDir = mkdtempSync(path.join(tmpdir(), "titan-console-smoke-"));
  const child = spawn(process.execPath, [path.join(release, "apps/console/dist/cli.js")], { env: smokeEnv(port, stateDir), stdio: "ignore" });
  try {
    const answered = await pollSha(port, sha);
    if (answered !== sha) return `the new build on spare port ${port} answered /health ${answered === undefined ? "with nothing" : `as ${answered ?? "no build sha"}`}, not ${sha}`;
    return (await pageAnswers(port)) ? undefined : `the new build on spare port ${port} did not serve its page at /`;
  } finally {
    child.kill("SIGTERM");
    rmSync(stateDir, { recursive: true, force: true });
  }
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
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
    readFile,
    remove: (file) => rmSync(file, { force: true }),
    createExclusive,
    isAlive,
    smoke: smokeRelease,
    servedSha: (port, want) => pollSha(port, want),
    alarm: async (deposit) => void (await writeDeposit(inboxDir, deposit)),
    log: (line) => console.log(line),
    now: Date.now,
  };
}
