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
  /** Caps stdout and stderr each, in bytes; defaults to 32 MiB. Exceeding it rejects. */
  maxBufferBytes?: number;
  /** Extra child environment for this one call, merged over `process.env`; never written to `process.env` or argv. */
  env?: Readonly<Record<string, string>>;
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

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/** Uses the caller's existing `gh` login; this module never sees a token. */
export const execGh: GhExec = (args, input, options = {}) => execCommand("gh", args, input, options);

/** Runs `git` with an argv array, never through a shell; a credential rides in `options.env`, never in argv. */
export type GitExec = (args: readonly string[], options?: GhExecOptions) => Promise<GhResult>;

export const execGit: GitExec = (args, options = {}) => execCommand("git", args, undefined, options);

function execCommand(command: string, args: readonly string[], input: string | undefined, options: GhExecOptions): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const { timeoutMs, maxBufferBytes = DEFAULT_MAX_BUFFER, env } = options;
    const child = execFile(
      command,
      [...args],
      { maxBuffer: maxBufferBytes, ...(env === undefined ? {} : { env: { ...process.env, ...env } }), ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" as const }) },
      (error, stdout, stderr) => {
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new Error(`${command} ${args.slice(0, 2).join(" ")} output exceeded ${maxBufferBytes} bytes`));
        if (timeoutMs !== undefined && error?.killed) return reject(new Error(`${command} ${args.slice(0, 2).join(" ")} timed out after ${timeoutMs} ms`));
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}
