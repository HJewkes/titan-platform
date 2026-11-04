import { spawn, type ChildProcess } from "node:child_process";

interface CommandRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Milliseconds the runner spent held on load before it printed {@link WORK_STARTED}; absent when it printed none. */
  waitedMs?: number;
}

interface RunOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Time between SIGTERM and SIGKILL of the process group. */
  graceMs?: number;
  /** Extra time before the work-started marker, on top of `timeoutMs`, so a runner held on load is not killed for waiting. */
  waitAllowanceMs?: number;
  /** How long output may still arrive after the script exits before its pipes are cut, so a descendant holding them cannot hang the run. */
  drainMs?: number;
}

/** A runner prints this line on stderr when it stops waiting on host load and starts real work; the rung's timeout counts from it. */
const WORK_STARTED = "ar-work-started";

const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_DRAIN_MS = 2_000;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/** Process groups of evals still running, so the process owner can take them down: a detached group never gets the terminal's SIGINT. */
const liveGroups = new Map<number, number>();
const stopping = { done: undefined as Promise<void> | undefined, drained: () => {}, hardKill: undefined as NodeJS.Timeout | undefined };

function killLive(signal: NodeJS.Signals): void {
  for (const pid of liveGroups.keys()) killGroup(pid, signal);
}

/**
 * SIGTERM every live eval group, SIGKILL after the longest grace, and SIGKILL any group spawned before the last one is
 * down; resolves once none is left. A call while stopping skips the rest of the grace. It never exits or signals the
 * process: that belongs to whoever owns the process, the CLI or serve.
 */
export function stopEvals(): Promise<void> {
  if (stopping.done) return (killLive("SIGKILL"), stopping.done);
  killLive("SIGTERM");
  stopping.hardKill = setTimeout(() => killLive("SIGKILL"), Math.max(0, ...liveGroups.values()));
  stopping.done = new Promise((done) => (stopping.drained = done));
  if (liveGroups.size === 0) drain();
  return stopping.done;
}

function drain(): void {
  clearTimeout(stopping.hardKill);
  stopping.done = undefined;
  stopping.drained();
}

function track(pid: number | undefined, graceMs: number): () => void {
  if (pid === undefined) return () => {};
  liveGroups.set(pid, graceMs);
  if (stopping.done) killGroup(pid, "SIGKILL");
  return () => {
    liveGroups.delete(pid);
    if (liveGroups.size === 0 && stopping.done) drain();
  };
}

interface Guard {
  stop(reason: string): void;
  arm(allowanceMs: number): void;
  clear(): void;
  reason(): string | undefined;
}

/** SIGTERM to the group at the deadline, SIGKILL after the grace period; `reason` stays the first cause. */
function guardOf(child: ChildProcess, { timeoutMs, graceMs }: { timeoutMs?: number; graceMs: number }): Guard {
  let [deadline, hardKill, reason] = [undefined as NodeJS.Timeout | undefined, undefined as NodeJS.Timeout | undefined, undefined as string | undefined];
  const stop = (why: string) => {
    reason ??= why;
    if (child.pid === undefined) return;
    killGroup(child.pid, "SIGTERM");
    hardKill ??= setTimeout(() => killGroup(child.pid!, "SIGKILL"), graceMs);
  };
  const arm = (allowanceMs: number) => {
    if (timeoutMs === undefined) return;
    clearTimeout(deadline);
    deadline = setTimeout(() => stop(`timed out after ${timeoutMs + allowanceMs} ms`), timeoutMs + allowanceMs);
  };
  const untrack = track(child.pid, graceMs);
  const clear = () => (clearTimeout(deadline), clearTimeout(hardKill), untrack());
  return { stop, arm, clear, reason: () => reason };
}

/** Buffers both streams up to {@link MAX_BUFFER}; `onWorkStarted` runs once, at the first {@link WORK_STARTED} line. */
function collect(child: ChildProcess, out: { stdout: string; stderr: string; waitedMs?: number }, onWorkStarted: () => void): void {
  child.stdout?.on("data", (chunk) => void (out.stdout.length < MAX_BUFFER && (out.stdout += chunk)));
  child.stderr?.on("data", (chunk) => {
    if (out.stderr.length < MAX_BUFFER) out.stderr += chunk;
    if (out.waitedMs === undefined && String(chunk).split("\n").some((line) => line.trim() === WORK_STARTED)) onWorkStarted();
  });
}

/**
 * Once the script exits, the group is left `drainMs` to flush output, then killed and its pipes cut: a descendant that
 * holds stdout, even one that left the group, would otherwise keep `close` from ever firing.
 */
function drainAfterExit(child: ChildProcess, drainMs: number): void {
  let cut: NodeJS.Timeout | undefined;
  child.once("exit", () => {
    cut = setTimeout(() => {
      if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, drainMs);
  });
  child.once("close", () => clearTimeout(cut));
}

/**
 * Runs one argv without a shell, in its own process group so a timeout or abort takes down every descendant, not just
 * the script: SIGTERM first, SIGKILL after the grace period. A non-zero exit, or a kill from outside such as the
 * kernel's OOM killer, is an answer, not a throw, so a suite failure becomes an L0 row and a killed eval a failed step.
 */
export function runCommand(argv: readonly string[], options: RunOptions): Promise<CommandRun> {
  const [file, ...args] = argv;
  if (!file) return Promise.reject(new Error("[command] empty argv"));
  const { cwd, signal, graceMs = DEFAULT_GRACE_MS, waitAllowanceMs = 0, drainMs = DEFAULT_DRAIN_MS } = options;
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const guard = guardOf(child, { timeoutMs: options.timeoutMs, graceMs });
    const [started, out] = [Date.now(), { stdout: "", stderr: "", waitedMs: undefined as number | undefined, spawnError: undefined as string | undefined }];
    const onAbort = () => guard.stop("aborted");
    guard.arm(waitAllowanceMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    collect(child, out, () => {
      out.waitedMs = Date.now() - started;
      guard.arm(0);
    });
    child.on("error", (error) => (out.spawnError = error.message));
    drainAfterExit(child, drainMs);
    child.on("close", (code, killed) => {
      guard.clear();
      signal?.removeEventListener("abort", onAbort);
      // A descendant that outlived the script is still in the group; reap it on the normal path too.
      if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      resolve(finish(out, guard.reason() ?? out.spawnError ?? killedBy(killed), code));
    });
  });
}

const killedBy = (signal: NodeJS.Signals | null) => (signal === null ? undefined : `killed by ${signal}`);

/** The cause is the last stderr line, so `lastLine`'s error names a timeout or an outside kill even after the script logged. */
function finish(out: { stdout: string; stderr: string; waitedMs?: number }, failure: string | undefined, code: number | null): CommandRun {
  const ok = failure === undefined && code === 0;
  const cause = failure ?? (out.stderr ? undefined : `exit ${code}`);
  const stderr = ok || cause === undefined ? out.stderr : [out.stderr.trimEnd(), cause].filter(Boolean).join("\n");
  return { ok, stdout: out.stdout, stderr, ...(out.waitedMs === undefined ? {} : { waitedMs: out.waitedMs }) };
}

/** A target prints its one JSON result as the last non-empty stdout line; anything before it is the runner's own log. */
export function lastLine(run: CommandRun, argv: readonly string[]): unknown {
  const line = run.stdout.trim().split("\n").at(-1);
  if (!run.ok || !line) throw new Error(`[command] ${argv.join(" ")} failed: ${run.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  return JSON.parse(line);
}
