import { execFile } from "node:child_process";

interface CommandRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Runs one argv without a shell; a non-zero exit is an answer, not a throw, so a suite failure becomes an L0 row. */
export function runCommand(argv: readonly string[], { cwd, signal, timeoutMs }: RunOptions): Promise<CommandRun> {
  const [file, ...args] = argv;
  if (!file) return Promise.reject(new Error("[command] empty argv"));
  return new Promise((resolve) => {
    execFile(file, args, { cwd, signal, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: error && !stderr ? error.message : String(stderr) });
    });
  });
}

/** A target prints its one JSON result as the last non-empty stdout line; anything before it is the runner's own log. */
export function lastLine(run: CommandRun, argv: readonly string[]): unknown {
  const line = run.stdout.trim().split("\n").at(-1);
  if (!run.ok || !line) throw new Error(`[command] ${argv.join(" ")} failed: ${run.stderr.trim().split("\n").slice(-3).join(" | ")}`);
  return JSON.parse(line);
}
