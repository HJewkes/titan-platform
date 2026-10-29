/**
 * Start a real HTTP daemon from the built CLI (`dist/cli.js mcp serve`).
 *
 * Spawning the bundle skips the cold `tsx` transpile each daemon used to pay,
 * and the child is the daemon itself rather than a wrapper around it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { requireDistBin } from './cli-runner.js';
import { captureStderr } from './child-startup.js';

export interface SpawnedDaemon {
  child: ChildProcess;
  stderr: () => string;
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.createServer();
    sock.listen(0, '127.0.0.1', () => {
      const { port } = sock.address() as net.AddressInfo;
      sock.close(() => resolve(port));
    });
    sock.on('error', reject);
  });
}

/**
 * Every path env var points inside `stateRoot`, HOME included, so macOS
 * env-paths cannot reach the real install.
 */
export function spawnDaemon(port: number, stateRoot: string, activeRoot: string): SpawnedDaemon {
  const child = spawn(process.execPath, [requireDistBin(), 'mcp', 'serve', '--port', String(port)], {
    env: {
      ...process.env,
      AW_PORT: String(port),
      XDG_STATE_HOME: stateRoot,
      XDG_DATA_HOME: stateRoot,
      XDG_CONFIG_HOME: stateRoot,
      XDG_CACHE_HOME: stateRoot,
      ACTIVE_ROOT: activeRoot,
      HOME: stateRoot,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return { child, stderr: captureStderr(child.stderr, '[daemon]') };
}

export async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('daemon did not exit in time')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** SIGTERM the daemon and wait for it; SIGKILL it if it outlives `timeoutMs`. */
export async function stopDaemon(child: ChildProcess, timeoutMs: number): Promise<void> {
  child.kill('SIGTERM');
  await waitForExit(child, timeoutMs).catch(() => child.kill('SIGKILL'));
}

export function findDaemonPidFile(root: string): string | null {
  if (!existsSync(root)) return null;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'daemon.pid') return full;
    }
  }
  return null;
}
