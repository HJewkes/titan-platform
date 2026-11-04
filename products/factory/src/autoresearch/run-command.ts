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
}

/** A runner prints this line on stderr when it stops waiting on host load and starts real work; the rung's timeout counts from it. */
const WORK_STARTED = "ar-work-started";

const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_GRACE_MS = 5_000;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
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
  const clear = () => (clearTimeout(deadline), clearTimeout(hardKill));
  return { stop, arm, clear, reason: () => reason };
}

/**
 * Runs one argv without a shell, in its own process group so a timeout or abort takes down every descendant, not just
 * the script: SIGTERM first, SIGKILL after the grace period. A non-zero exit is an answer, not a throw, so a suite
 * failure becomes an L0 row.
 */
export function runCommand(argv: readonly string[], options: RunOptions): Promise<CommandRun> {
  const [file, ...args] = argv;
  if (!file) return Promise.reject(new Error("[command] empty argv"));
  const { cwd, signal, graceMs = DEFAULT_GRACE_MS, waitAllowanceMs = 0 } = options;
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const guard = guardOf(child, { timeoutMs: options.timeoutMs, graceMs });
    const [started, out] = [Date.now(), { stdout: "", stderr: "", waitedMs: undefined as number | undefined, spawnError: undefined as string | undefined }];
    const onAbort = () => guard.stop("aborted");
    guard.arm(waitAllowanceMs);
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => void (out.stdout.length < MAX_BUFFER && (out.stdout += chunk)));
    child.stderr.on("data", (chunk) => {
      if (out.stderr.length < MAX_BUFFER) out.stderr += chunk;
      if (out.waitedMs === undefined && String(chunk).split("\n").some((line) => line.trim() === WORK_STARTED)) {
        out.waitedMs = Date.now() - started;
        guard.arm(0);
      }
    });
    child.on("error", (error) => (out.spawnError = error.message));
    child.on("close", (code) => {
      guard.clear();
      signal?.removeEventListener("abort", onAbort);
      // A descendant that outlived the script is still in the group; reap it on the normal path too.
      if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      resolve(finish(out, guard.reason() ?? out.spawnError, code));
    });
  });
}

function finish(out: { stdout: string; stderr: string; waitedMs?: number }, failure: string | undefined, code: number | null): CommandRun {
  const ok = failure === undefined && code === 0;
  return { ok, stdout: out.stdout, stderr: !ok && !out.stderr ? (failure ?? `exit ${code}`) : out.stderr, ...(out.waitedMs === undefined ? {} : { waitedMs: out.waitedMs }) };
}

/** A target prints its one JSON result as the last non-empty stdout line; anything before it is the runner's own log. */
export function lastLine(run: CommandRun, argv: readonly string[]): unknown {
  const line = run.stdout.trim().split("\n").at(-1);
  if (!run.ok || !line) throw new Error(`[command] ${argv.join(" ")} failed: ${run.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  return JSON.parse(line);
}
