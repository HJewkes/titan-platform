import { execFile } from "node:child_process";

const COMMAND_TIMEOUT_MS = 30_000;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Resolves with the exit code instead of rejecting, and with undefined when the binary is not on PATH. */
export function runCommand(file: string, args: readonly string[], env?: Readonly<Record<string, string>>): Promise<CommandResult | undefined> {
  return new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, ...(env ? { env: { ...process.env, ...env } } : {}) }, (error, stdout, stderr) => {
      if (error?.code === "ENOENT") return resolve(undefined);
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr: stderr || error?.message || "" });
    });
  });
}
