// The fixed trigger titan-console-update.service runs (TP-4043). An older unit's bare `self-update` runs the serving
// release's copy; the owner may copy it outside the app, so no release can break it. It only locks, fetches, builds origin/main into releases/<sha> and hands off to that
// build's own `self-update --apply`, so a fix to the updater applies itself. Everything else lives in the versioned
// updater; keep this file small, because a bug here takes an owner step to fix.
// Node runs it as is (type stripping), so it imports only node builtins and uses only erasable syntax.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Every effect the bootstrap has; tests pass fakes. */
export interface BootstrapPorts {
  pid: number;
  run: (file: "git" | "pnpm", args: readonly string[], cwd: string) => Promise<CommandResult>;
  /** Runs `node <script> ...args` with the output inherited and resolves its exit code. */
  handOff: (script: string, args: readonly string[]) => Promise<number>;
  readFile: (file: string) => string | undefined;
  writeFile: (file: string, text: string) => void;
  /** False when the file already exists. */
  createExclusive: (file: string, text: string) => boolean;
  remove: (file: string) => void;
  isAlive: (pid: number) => boolean;
  exists: (file: string) => boolean;
  mkdir: (dir: string) => void;
  log: (line: string) => void;
  now: () => number;
}

export interface BootstrapOptions {
  /** Holds `checkout/`, `releases/<sha>/` and the `current` symlink. */
  root: string;
  /** Holds the locks, `self-update.json` and the last build log, shared with the updater. */
  stateDir: string;
}

export const EXIT = { OK: 0, FAILED: 1, LOCKED: 75, CONFIG: 78 } as const;
export const RELEASE_CLI = "apps/console/dist/cli.js";
/** `build` writes it last, so a release that has it finished building. */
const BUILT_MARKER = "apps/console/dist/build-info.json";
const BUILD_STEPS: readonly (readonly string[])[] = [["install", "--frozen-lockfile"], ["--filter", "titan-console...", "build"]];
const DETAIL_LINES = 20;

export const applyArgs = (sha: string): string[] => ["self-update", "--apply", sha];
export const REPORT_ARGS: readonly string[] = ["self-update", "--report"];
export const recordFile = (stateDir: string): string => path.join(stateDir, "self-update.json");
const lockFile = (stateDir: string): string => path.join(stateDir, "self-update-bootstrap.lock");

interface Pass {
  ports: BootstrapPorts;
  options: BootstrapOptions;
  checkout: string;
  current: string;
}

export async function bootstrap(ports: BootstrapPorts, options: BootstrapOptions): Promise<number> {
  ports.mkdir(options.stateDir);
  const lock = lockFile(options.stateDir);
  const held = takeLock(ports, lock);
  if (held !== undefined) {
    ports.log(`bootstrap refused: ${held}`);
    return EXIT.LOCKED;
  }
  try {
    return await pass({ ports, options, checkout: path.join(options.root, "checkout"), current: path.join(options.root, "current") });
  } finally {
    if (Number(ports.readFile(lock)) === ports.pid) ports.remove(lock);
  }
}

function takeLock(ports: BootstrapPorts, file: string): string | undefined {
  if (ports.createExclusive(file, String(ports.pid))) return undefined;
  const holder = Number(ports.readFile(file)?.trim());
  if (Number.isInteger(holder) && holder > 0 && ports.isAlive(holder)) return `pid ${holder} holds ${file}`;
  ports.remove(file);
  return ports.createExclusive(file, String(ports.pid)) ? undefined : `another run took ${file} first`;
}

const detail = (result: CommandResult): string => `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-DETAIL_LINES).join("\n") || `exit ${result.code}`;

async function revParse(ports: BootstrapPorts, cwd: string, rev: string): Promise<string | undefined> {
  const parsed = await ports.run("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cwd);
  return parsed.code === 0 ? parsed.stdout.trim() : undefined;
}

async function pass(run: Pass): Promise<number> {
  const { ports, options, checkout, current } = run;
  const fetched = await ports.run("git", ["fetch", "--quiet", "origin", "main"], checkout);
  if (fetched.code !== 0) return stop(ports, EXIT.FAILED, `git fetch origin main failed: ${detail(fetched)}`);
  const target = await revParse(ports, checkout, "origin/main");
  if (target === undefined) return stop(ports, EXIT.FAILED, `could not resolve origin/main in ${checkout}`);
  const served = await revParse(ports, current, "HEAD");
  if (served === undefined) return stop(ports, EXIT.CONFIG, `${current} is not the served checkout; run the owner step in apps/console/docs/self-update.md`);
  if (served === target) return stop(ports, EXIT.OK, `up to date: serving ${target}`);
  if (judgedTarget(ports.readFile(recordFile(options.stateDir))) === target) return stop(ports, EXIT.OK, `${target} was already judged; see ${recordFile(options.stateDir)}`);
  const release = path.join(options.root, "releases", target);
  if (!ports.exists(path.join(release, BUILT_MARKER))) {
    const why = await build(run, release, target);
    if (why !== undefined) return failed(run, { target, served, stage: "build", why });
  }
  ports.log(`handing off to ${target}'s own updater`);
  const code = await ports.handOff(path.join(release, RELEASE_CLI), applyArgs(target));
  if (code === EXIT.OK || code === EXIT.LOCKED || judgedTarget(ports.readFile(recordFile(options.stateDir))) === target) return code;
  return failed(run, { target, served, stage: "handoff", why: `${target}'s updater exited ${code} without recording an outcome` });
}

function stop(ports: BootstrapPorts, code: number, message: string): number {
  ports.log(message);
  return code;
}

/** The sha the last attempt judged; the versioned updater owns the record, so this reads only its `target`. */
function judgedTarget(text: string | undefined): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text ?? "");
    return typeof parsed === "object" && parsed !== null && "target" in parsed && typeof parsed.target === "string" ? parsed.target : undefined;
  } catch {
    return undefined;
  }
}

/** A leftover worktree from an earlier attempt is replaced, so a rerun starts clean; a failed build is removed. */
async function build(run: Pass, release: string, target: string): Promise<string | undefined> {
  const { ports, checkout } = run;
  if (ports.exists(release)) await ports.run("git", ["worktree", "remove", "--force", release], checkout);
  ports.mkdir(path.dirname(release));
  const added = await ports.run("git", ["worktree", "add", "--detach", release, target], checkout);
  if (added.code !== 0) return `git worktree add failed: ${detail(added)}`;
  for (const args of BUILD_STEPS) {
    const result = await ports.run("pnpm", args, release);
    if (result.code === 0) continue;
    ports.writeFile(path.join(run.options.stateDir, "self-update-build.log"), `pnpm ${args.join(" ")} at ${target}\n${result.stdout}\n${result.stderr}\n`);
    await ports.run("git", ["worktree", "remove", "--force", release], checkout);
    return `pnpm ${args.join(" ")} failed: ${detail(result)}`;
  }
  return undefined;
}

interface Failure {
  target: string;
  served: string;
  stage: "build" | "handoff";
  why: string;
}

/** Records the failure in the updater's record shape, so the target is held, then has the serving build file the alarm. */
async function failed(run: Pass, failure: Failure): Promise<number> {
  const { ports, options, current } = run;
  ports.log(`error: ${failure.stage} of ${failure.target} failed: ${failure.why}`);
  const record = { outcome: "failed", target: failure.target, served: failure.served, at: new Date(ports.now()).toISOString(), stage: failure.stage, why: failure.why };
  ports.writeFile(recordFile(options.stateDir), `${JSON.stringify(record, null, 2)}\n`);
  const reported = await ports.handOff(path.join(current, RELEASE_CLI), REPORT_ARGS);
  if (reported !== EXIT.OK) ports.log(`error: the serving build's self-update --report exited ${reported}, so no owner-queue alarm was filed`);
  return EXIT.FAILED;
}

const COMMAND_TIMEOUT_MS = 20 * 60_000;
const MAX_OUTPUT = 64 * 1024 * 1024;

function runCommand(file: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout, stderr: error !== null && stderr === "" ? error.message : stderr });
    });
  });
}

function handOff(script: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
    child.once("error", () => resolve(EXIT.FAILED));
    child.once("close", (code) => resolve(code ?? EXIT.FAILED));
  });
}

function createExclusive(file: string, text: string): boolean {
  try {
    writeFileSync(file, text, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function nodePorts(): BootstrapPorts {
  return {
    pid: process.pid,
    run: runCommand,
    handOff,
    readFile: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
    writeFile: (file, text) => writeFileSync(file, text, { mode: 0o600 }),
    createExclusive,
    remove: (file) => rmSync(file, { force: true }),
    isAlive,
    exists: existsSync,
    mkdir: (dir) => void mkdirSync(dir, { recursive: true, mode: 0o700 }),
    log: (line) => console.log(line),
    now: Date.now,
  };
}

const expandHome = (value: string): string => (value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value);

/** The same defaults and overrides the console and its updater read. */
export function optionsFrom(env: NodeJS.ProcessEnv): BootstrapOptions {
  return {
    root: expandHome(env.TITAN_CONSOLE_UPDATE_ROOT || "~/.local/share/titan-console"),
    stateDir: expandHome(env.TITAN_CONSOLE_STATE || "~/.local/state/titan-console"),
  };
}

/**
 * Node resolves symlinks for the main module but leaves argv[1] as given, so a launch through `current/` (the legacy
 * bare `self-update`) or a symlinked home would never match a plain comparison and the pass would silently not run.
 */
export function isMainModule(moduleUrl: string, argv1: string | undefined, realpath: (file: string) => string = realpathSync): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpath(fileURLToPath(moduleUrl)) === realpath(argv1);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) process.exitCode = await bootstrap(nodePorts(), optionsFrom(process.env));
