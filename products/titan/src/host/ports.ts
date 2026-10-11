import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Every process and file touch the host doctor makes; tests inject fakes. */
export interface HostPorts {
  /** Rejects with an error whose `code` is "ENOENT" when the command is not on PATH. */
  exec(command: string, args: string[]): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  /** What sits at a path, symlinks followed, or null when nothing does. Never opens the file. */
  stat(path: string): Promise<"file" | "dir" | null>;
  /** The entry names in a directory, or none when it cannot be listed. */
  list(dir: string): Promise<string[]>;
  /** The real path of a command on PATH, symlinks resolved, or null. */
  which(command: string): Promise<string | null>;
}

const EXEC_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT = 124;

export function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

export function realHostPorts(env: NodeJS.ProcessEnv): HostPorts {
  return {
    exec: (command, args) => execCommand(command, args, env),
    readFile: (path) => readFile(path, "utf8"),
    stat: statKind,
    list: (dir) => readdir(dir).catch(() => []),
    which: (command) => whichCommand(command, env),
  };
}

function execCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, timeout: EXEC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      if (isEnoent(error)) return reject(error);
      if (error.killed) return resolve({ code: EXIT_TIMEOUT, stdout, stderr: `timed out after ${EXEC_TIMEOUT_MS} ms` });
      resolve({ code: typeof error.code === "number" ? error.code : 1, stdout, stderr });
    });
  });
}

async function statKind(path: string): Promise<"file" | "dir" | null> {
  try {
    return (await stat(path)).isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

async function whichCommand(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, command);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      continue;
    }
  }
  return null;
}
