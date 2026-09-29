import { execFile } from "node:child_process";

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `gh` with an argv array and optional stdin; never through a shell. */
export type GhExec = (args: readonly string[], input?: string, options?: GhExecOptions) => Promise<GhResult>;

export interface GhExecOptions {
  /** Kills the child with SIGKILL and rejects once this many milliseconds pass. */
  timeoutMs?: number;
}

export class GhError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: GhResult,
    private readonly httpStatus?: number,
  ) {
    super(`gh ${args.slice(0, 4).join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "GhError";
  }

  get status(): number | undefined {
    if (this.httpStatus !== undefined) return this.httpStatus;
    const match = /\(HTTP (\d{3})\)/.exec(this.result.stderr);
    return match ? Number(match[1]) : undefined;
  }
}

/** Uses the caller's existing `gh` login; this module never sees a token. */
export const execGh: GhExec = (args, input, options = {}) =>
  new Promise((resolve, reject) => {
    const { timeoutMs } = options;
    const child = execFile(
      "gh",
      [...args],
      { maxBuffer: 32 * 1024 * 1024, ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" as const }) },
      (error, stdout, stderr) => {
        if (timeoutMs !== undefined && error?.killed) return reject(new Error(`gh ${args.slice(0, 2).join(" ")} timed out after ${timeoutMs} ms`));
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
