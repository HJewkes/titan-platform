import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
}

export interface ExecResult {
  /** Exit code, or null when a signal or the timeout ended the process. */
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one program without a shell; a runner swaps it in tests to observe or fail commands. */
export type Exec = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

/** The default Exec: node's spawn in its own process group, all of it killed at the timeout, never rejecting on a non-zero exit. */
export const spawnExec: Exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    // Its own group, so the timeout also kills a build's grandchildren, which would otherwise hold the pipes open.
    const child = spawn(file, args, { cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => killGroup(child.pid), options.timeoutMs);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(stdout).toString("utf-8"), stderr: Buffer.concat(stderr).toString("utf-8") });
    });
  });

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group already exited between the timer firing and the kill.
  }
}
