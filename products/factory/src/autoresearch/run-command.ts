import { spawn } from "node:child_process";

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
export const WORK_STARTED = "ar-work-started";

const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_GRACE_MS = 5_000;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Runs one argv without a shell, in its own process group so a timeout or abort takes down every descendant, not just
 * the script: SIGTERM first, SIGKILL after the grace period. A non-zero exit is an answer, not a throw, so a suite
 * failure becomes an L0 row.
 */
export function runCommand(argv: readonly string[], { cwd, signal, timeoutMs, graceMs = DEFAULT_GRACE_MS, waitAllowanceMs = 0 }: RunOptions): Promise<CommandRun> {
  const [file, ...args] = argv;
  if (!file) return Promise.reject(new Error("[command] empty argv"));
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const started = Date.now();
    let [stdout, stderr, failure, waitedMs] = ["", "", undefined as string | undefined, undefined as number | undefined];
    let deadline: NodeJS.Timeout | undefined;
    let hardKill: NodeJS.Timeout | undefined;

    const stop = (reason: string) => {
      failure ??= reason;
      if (child.pid === undefined) return;
      killGroup(child.pid, "SIGTERM");
      hardKill ??= setTimeout(() => killGroup(child.pid!, "SIGKILL"), graceMs);
    };
    const arm = (allowanceMs: number) => {
      if (timeoutMs === undefined) return;
      clearTimeout(deadline);
      deadline = setTimeout(() => stop(`timed out after ${timeoutMs + allowanceMs} ms`), timeoutMs + allowanceMs);
    };
    const onAbort = () => stop("aborted");

    arm(waitAllowanceMs);
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => void (stdout.length < MAX_BUFFER && (stdout += chunk)));
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk;
      if (waitedMs === undefined && String(chunk).split("\n").some((line) => line.trim() === WORK_STARTED)) {
        waitedMs = Date.now() - started;
        arm(0);
      }
    });
    child.on("error", (error) => (failure ??= error.message));
    child.on("close", (code) => {
      clearTimeout(deadline);
      clearTimeout(hardKill);
      signal?.removeEventListener("abort", onAbort);
      // A descendant that outlived the script is still in the group; reap it on the normal path too.
      if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      const ok = failure === undefined && code === 0;
      resolve({ ok, stdout, stderr: !ok && !stderr ? (failure ?? `exit ${code}`) : stderr, ...(waitedMs === undefined ? {} : { waitedMs }) });
    });
  });
}

/** A target prints its one JSON result as the last non-empty stdout line; anything before it is the runner's own log. */
export function lastLine(run: CommandRun, argv: readonly string[]): unknown {
  const line = run.stdout.trim().split("\n").at(-1);
  if (!run.ok || !line) throw new Error(`[command] ${argv.join(" ")} failed: ${run.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  return JSON.parse(line);
}
