/**
 * Two ways to run the active-work CLI from a test.
 *
 * `runCli` spawns the built `dist/cli.js`, for cases about the process itself:
 * its exit status, its stderr, the version the bundle was built with. Every other
 * command-output case uses `runCliInProcess`, which drives `src/cli.ts` through
 * commander's `parseAsync` in the test worker and saves a node start per call.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST_BIN = path.join(REPO_ROOT, 'dist', 'cli.js');

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

type Env = Record<string, string>;

// CI builds the CLI before tests run; a missing bundle is a setup error, not a slow tsx fallback.
export function requireDistBin(): string {
  if (!existsSync(DIST_BIN)) {
    throw new Error(`Built CLI missing at ${DIST_BIN}; run \`pnpm build:cli\` first.`);
  }
  return DIST_BIN;
}

function processEnv(env: Env): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: '1', ...env };
}

export function runCli(args: string[], env: Env = {}): RunResult {
  const result = spawnSync(process.execPath, [requireDistBin(), ...args], {
    encoding: 'utf8',
    env: processEnv(env),
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function runCliAsync(args: string[], env: Env = {}): Promise<RunResult> {
  const child = spawn(process.execPath, [requireDistBin(), ...args], { env: processEnv(env) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) => {
    child.on('close', (status) => resolve({ status: status ?? -1, stdout, stderr }));
  });
}

type Main = (argv: string[]) => Promise<void>;
type WriteCallback = (err?: Error | null) => void;

let mainPromise: Promise<Main> | undefined;
// In-process runs share stdout, stderr and process.env, so they take turns.
let queue: Promise<unknown> = Promise.resolve();

// main() adds an EPIPE listener per call; drop them so a long file stays under the listener cap.
function keepErrorListeners(): () => void {
  const streams = [process.stdout, process.stderr];
  const before = streams.map((stream) => stream.listeners('error'));
  return () =>
    streams.forEach((stream, i) => {
      for (const l of stream.listeners('error')) {
        if (!before[i]!.includes(l)) stream.off('error', l as never);
      }
    });
}

/** Swap stdout, stderr and process.exit for recorders until the returned restore runs. */
function capture(): { result: () => RunResult; exited: Promise<void>; restore: () => void } {
  const out = { stdout: '', stderr: '', status: undefined as number | undefined };
  let onExit = (): void => {};
  const exited = new Promise<void>((resolve) => (onExit = resolve));
  const recorder = (stream: 'stdout' | 'stderr') =>
    ((chunk: string | Uint8Array, encOrCb?: unknown, cb?: unknown): boolean => {
      out[stream] += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      const done = (typeof encOrCb === 'function' ? encOrCb : cb) as WriteCallback | undefined;
      done?.();
      return true;
    }) as typeof process.stdout.write;
  const dropAddedListeners = keepErrorListeners();
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation(recorder('stdout')),
    vi.spyOn(process.stderr, 'write').mockImplementation(recorder('stderr')),
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      out.status ??= code ?? 0;
      onExit();
    }) as typeof process.exit),
  ];
  const restore = (): void => {
    for (const spy of spies) spy.mockRestore();
    dropAddedListeners();
  };
  return { result: () => ({ status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr }), exited, restore };
}

// Importing src/cli.ts runs main(process.argv) once; point that run at --version and let it finish quietly.
async function loadMain(): Promise<Main> {
  const argv = process.argv;
  process.argv = [process.execPath, 'active-work', '--version'];
  process.env.NO_COLOR = '1';
  const run = capture();
  try {
    const mod = (await import('../../src/cli.js')) as { main: Main };
    await run.exited;
    return mod.main;
  } finally {
    run.restore();
    process.argv = argv;
  }
}

async function runOnce(args: string[], env: Env): Promise<RunResult> {
  const main = await (mainPromise ??= loadMain());
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const run = capture();
  try {
    await main([process.execPath, 'active-work', ...args]);
    return run.result();
  } finally {
    run.restore();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Run one CLI invocation in this worker; status is the code the CLI would have exited with. */
export function runCliInProcess(args: string[], env: Env = {}): Promise<RunResult> {
  const next = queue.then(() => runOnce(args, env));
  queue = next.catch(() => undefined);
  return next;
}
