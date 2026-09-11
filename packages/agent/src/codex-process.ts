import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export interface CodexProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface SupervisedCodexProcess {
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  completed: Promise<CodexProcessExit>;
  terminate(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface CodexSchemaFile {
  path: string;
  dispose(): Promise<void>;
}

export interface CodexProcessInput {
  executablePath: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

export interface CodexVersionInspectionOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

export async function inspectCodexVersion(
  executablePath: string,
  env: Record<string, string>,
  options: CodexVersionInspectionOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executablePath,
      ["--version"],
      {
        env,
        encoding: "utf8",
        signal: options.signal,
        timeout: Math.max(1, Math.ceil(options.timeoutMs)),
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

export function startCodexProcess(input: CodexProcessInput): SupervisedCodexProcess {
  const child = spawn(input.executablePath, input.args, {
    cwd: input.cwd,
    env: input.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: lines(child.stdout),
    stderr: lines(child.stderr),
    completed: completionOf(child),
    terminate: (signal) => terminateProcessGroup(child, signal),
  };
}

export async function createCodexSchemaFile(schema: Record<string, unknown>): Promise<CodexSchemaFile> {
  const directory = await mkdtemp(join(tmpdir(), "titan-codex-schema-"));
  const path = join(directory, "output-schema.json");
  try {
    await writeFile(path, JSON.stringify(schema), { encoding: "utf8", mode: 0o600 });
    return { path, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function* lines(stream: Readable): AsyncIterable<string> {
  const reader = createInterface({ input: stream });
  for await (const line of reader) yield line;
}

type SpawnedCodexProcess = ChildProcessByStdio<null, Readable, Readable>;

function completionOf(child: SpawnedCodexProcess): Promise<CodexProcessExit> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function terminateProcessGroup(child: SpawnedCodexProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // A failed group signal still gets a direct-child fallback.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Cleanup is idempotent; the child may already have exited.
  }
}
