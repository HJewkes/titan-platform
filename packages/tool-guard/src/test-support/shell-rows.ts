import { spawn, spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { beforeAll } from "vitest";

/** One run a real-shell oracle used to start with its own `spawnSync`, spelled as that call was. */
export interface ShellRun {
  /** Names the row in the error a timeout raises, so a hung row is found by name. */
  name: string;
  program: string;
  args: readonly string[];
  cwd: string;
  /** The whole environment, as `spawnSync`'s `env` sets it; absent, the run inherits this process's. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Set over this process's environment, as `env: { ...process.env, ...extraEnv }` would; ignored beside `env`. */
  extraEnv?: Readonly<Record<string, string>>;
  /** Stdin, through a pipe as `spawnSync`'s `input` gives it; absent, `/dev/null`, as `stdio: "ignore"` gives it. */
  input?: string;
}

export interface ShellResult {
  /** As bash's `$?` reports it, so a signalled run reads 128 plus the signal. */
  status: number;
  stdout: string;
  stderr: string;
}

/** How long one row may run before its process group is killed and the row fails by name; the oracles used 10 s. */
export const ROW_TIMEOUT_MS = 10_000;

/**
 * A process `spawnSync` started in its own group, and every process left in that group killed once it exits:
 * zsh's sync pipe after the shell exits; 1,514 of them piled up on basement and stalled the
 * agent-chat broker, which scans every process.
 */
export function spawnInGroup(program: string, args: string[], options: SpawnSyncOptions): void {
  // spawnSync honours detached (libuv starts a new session) though its type leaves it out.
  const inGroup: SpawnSyncOptions & { detached: boolean } = { ...options, detached: true };
  const { pid } = spawnSync(program, args, inGroup);
  if (pid <= 0) return;
  killGroup(pid);
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: nothing in the group outlived its leader.
  }
}

const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/** `env -i` with the run's own environment, as spawnSync's `env` replaces the whole of it. */
function commandOf(run: ShellRun): string {
  const argv = [run.program, ...run.args].map(quote).join(" ");
  const pairs = (env: Readonly<Record<string, string | undefined>>): string =>
    Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [quote(`${key}=${value}`)])).join(" ");
  if (run.env !== undefined) return `env -i ${pairs(run.env)} ${argv}`;
  if (run.extraEnv !== undefined) return `env ${pairs(run.extraEnv)} ${argv}`;
  return argv;
}

/**
 * Each row in its own process group under job control, its group killed when it exits as spawnInGroup kills it; the
 * markers let this process time out one row by its pid without stopping the rows after it.
 */
function driverOf(runs: readonly ShellRun[], io: string): string {
  const rows = runs.map((run, i) => {
    const stdin = run.input === undefined ? "</dev/null" : `< <(cat ${quote(join(io, `${i}.in`))})`;
    const redirects = `${stdin} >${quote(join(io, `${i}.out`))} 2>${quote(join(io, `${i}.err`))}`;
    return `(cd ${quote(run.cwd)} && exec ${commandOf(run)}) ${redirects} &\np=$!; echo "s ${i} $p"; wait "$p"; st=$?; kill -9 -- "-$p" 2>/dev/null; echo "e ${i} $st"`;
  });
  return `set -m\n${rows.join("\n")}\n`;
}

interface Progress {
  status: Map<number, number>;
  timedOut: Set<number>;
}

function watch(driver: string, timeoutMs: number): Promise<Progress> {
  const progress: Progress = { status: new Map(), timedOut: new Set() };
  const child = spawn("bash", ["--norc", "--noprofile", driver], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let timer: NodeJS.Timeout | undefined;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const [kind, row, value] = line.split(" ");
    clearTimeout(timer);
    if (kind === "s") {
      timer = setTimeout(() => {
        progress.timedOut.add(Number(row));
        killGroup(Number(value));
      }, timeoutMs);
    } else progress.status.set(Number(row), Number(value));
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      if (child.pid !== undefined) killGroup(child.pid);
      resolve(progress);
    });
  });
}

/** A row's outcome; reading one that timed out or never ran throws, naming it. */
export interface ShellRows {
  of(i: number): ShellResult;
}

/**
 * Runs every row from one bash driver instead of one `spawnSync` per row, each in a fresh process as before, with the
 * same argv, cwd, environment and stdin. A row past `timeoutMs` is killed and fails alone; the rows after it still run.
 */
export async function runShellRows(runs: readonly ShellRun[], timeoutMs = ROW_TIMEOUT_MS): Promise<ShellRows> {
  const io = mkdtempSync(join(tmpdir(), "tool-guard-shell-rows-"));
  try {
    runs.forEach((run, i) => {
      if (run.input !== undefined) writeFileSync(join(io, `${i}.in`), run.input);
    });
    writeFileSync(join(io, "driver.sh"), driverOf(runs, io));
    const progress = await watch(join(io, "driver.sh"), timeoutMs);
    const results = runs.map((run, i) => resultOf(run, i, io, progress, timeoutMs));
    return { of: (i) => unwrap(results[i], i) };
  } finally {
    rmSync(io, { recursive: true, force: true });
  }
}

function resultOf(run: ShellRun, i: number, io: string, progress: Progress, timeoutMs: number): ShellResult | Error {
  if (progress.timedOut.has(i)) return new Error(`shell row ${JSON.stringify(run.name)} ran past ${timeoutMs} ms and was killed`);
  const status = progress.status.get(i);
  if (status === undefined) return new Error(`shell row ${JSON.stringify(run.name)} never finished`);
  const read = (ext: string) => readFileSync(join(io, `${i}.${ext}`), "utf-8");
  return { status, stdout: read("out"), stderr: read("err") };
}

function unwrap(result: ShellResult | Error | undefined, i: number): ShellResult {
  if (result === undefined) throw new Error(`no shell row ${i}`);
  if (result instanceof Error) throw result;
  return result;
}

/** What one oracle row runs in its fresh directory, and what the test reads from the run. */
export interface OracleRow<R> {
  run: Omit<ShellRun, "name" | "cwd"> & { cwd?: string };
  read(result: ShellResult): R;
}

/**
 * Rows a test file's `it`s look up by the arguments they used to run with: `add` each at collection, `beforeAll` runs
 * them all through one driver, each in its own fresh directory, and `get` returns a row's reading or throws its error.
 */
export interface ShellOracle<A extends unknown[], R> {
  add(...args: A): void;
  /** Registers the vitest hook that runs every row added so far; call it after the adds. */
  beforeAll(): void;
  get(...args: A): R;
}

export function shellOracle<A extends unknown[], R>(prefix: string, row: (dir: string, ...args: A) => OracleRow<R>): ShellOracle<A, R> {
  const added = new Map<string, A>();
  const read = new Map<string, R | Error>();
  const key = (args: A): string => JSON.stringify(args);
  const runAll = async (): Promise<void> => {
    const root = mkdtempSync(join(tmpdir(), prefix));
    try {
      const keys = [...added.keys()];
      const rows = [...added.values()].map((args, i) => {
        const dir = join(root, `r${i}`);
        mkdirSync(dir);
        return { dir, ...row(dir, ...args) };
      });
      const results = await runShellRows(rows.map(({ dir, run }, i) => ({ name: keys[i] ?? "", cwd: dir, ...run })));
      rows.forEach(({ read: readRow }, i) => read.set(keys[i] ?? "", attempt(() => readRow(results.of(i)))));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  return {
    add: (...args) => void added.set(key(args), args),
    beforeAll: () => beforeAll(runAll, (added.size + 1) * ROW_TIMEOUT_MS),
    get: (...args) => {
      const reading = read.get(key(args));
      if (!read.has(key(args))) throw new Error(`shell row ${key(args)} was not added before the oracle ran`);
      if (reading instanceof Error) throw reading;
      return reading as R;
    },
  };
}

function attempt<R>(body: () => R): R | Error {
  try {
    return body();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
