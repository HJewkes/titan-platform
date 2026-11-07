import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ChoreOptions {
  cwd?: string;
  timeoutMs: number;
  /** How long after the chore exits its output may stay open, held by a daemon it left behind, before the result is taken. */
  pipeGraceMs?: number;
  env: NodeJS.ProcessEnv;
}

export interface ChoreResult {
  exitCode: number | null;
  signal: string | null;
  /** True when the chore outlived its timeout and its process group was killed. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Why the chore did not run to an exit, such as a missing program; absent for any exit code. */
  error?: string;
}

export type ChoreExec = (argv: readonly [string, ...string[]], options: ChoreOptions) => Promise<ChoreResult>;

// Host effects behind the post-merge recipe: kept out of post-merge.ts, which holds no I/O or clock use (D-M1b-07).
const POST_MERGE_PIPE_GRACE_MS = 2_000;
/** Output kept per stream before the tail is cut; wide enough that redaction sees any token near the kept tail whole. */
const KEPT_CHARS = 64 * 1024;

/** Runs argv with no shell and always resolves: a failed chore is evidence, since the merge already happened. */
export function execChore(argv: readonly [string, ...string[]], options: ChoreOptions): Promise<ChoreResult> {
  const [file, ...args] = argv;
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      watchChore(child, options, resolve);
    } catch (error) {
      resolve({ exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function watchChore(child: ChildProcess, options: ChoreOptions, resolve: (result: ChoreResult) => void): void {
  const stdout = keptTail(child.stdout!);
  const stderr = keptTail(child.stderr!);
  let timedOut = false;
  let graceTimer: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    timedOut = true;
    killGroup(child);
  }, options.timeoutMs);
  const settle = (outcome: Pick<ChoreResult, "exitCode" | "signal" | "error">) => {
    clearTimeout(timer);
    clearTimeout(graceTimer);
    child.stdout?.destroy();
    child.stderr?.destroy();
    resolve({ ...outcome, timedOut, stdout: stdout(), stderr: stderr() });
  };
  child.on("error", (error) => settle({ exitCode: null, signal: null, error: error.message }));
  child.on("exit", (exitCode, signal) => {
    clearTimeout(timer);
    graceTimer = setTimeout(() => settle({ exitCode, signal }), options.pipeGraceMs ?? POST_MERGE_PIPE_GRACE_MS);
  });
  child.on("close", (exitCode, signal) => settle({ exitCode, signal }));
}

/** Only the latest output is kept, so a chatty chore neither grows memory without bound nor gets killed for its output. */
function keptTail(stream: NodeJS.ReadableStream): () => string {
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    text += chunk;
    if (text.length > 2 * KEPT_CHARS) text = text.slice(-KEPT_CHARS);
  });
  return () => text;
}

/** SIGKILL cannot be trapped; the group kill and closed pipes stop a grandchild from holding the step open. */
function killGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/** What a post-merge step reads from the host; the code that builds the route passes it in, so the recipe never reaches the clock, environment or a process itself. */
export interface PostMergeHost {
  now: () => number;
  env: () => NodeJS.ProcessEnv;
  runChore: ChoreExec;
}

export const hostPostMerge = (): PostMergeHost => ({ now: () => Date.now(), env: () => process.env, runChore: execChore });

/** The transient unit's host: it reads its spec from disk and runs the chore itself. */
export interface ChoreSpecHost {
  env: () => NodeJS.ProcessEnv;
  readText: (file: string) => string;
  exec: ChoreExec;
}

export const hostChoreSpec = (): ChoreSpecHost => ({ env: () => process.env, readText: (file) => readFileSync(file, "utf8"), exec: execChore });
