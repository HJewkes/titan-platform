import { spawn } from "node:child_process";

export interface ToolRunResult {
  stdout: string;
  stderr: string;
  /** Null when the child was killed by a signal; see `signal`. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export function runTool(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<ToolRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    // Our own timer, because spawn's `timeout` option kills without telling us it did.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options?.timeout ?? 60_000);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(chunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
        exitCode: code,
        signal,
        timedOut,
      });
    });
  });
}
