import { spawn } from "node:child_process";

export interface ToolRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runTool(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<ToolRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      timeout: options?.timeout ?? 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString("utf-8"),
        stderr: Buffer.concat(errChunks).toString("utf-8"),
        exitCode: code ?? 1,
      });
    });
  });
}
