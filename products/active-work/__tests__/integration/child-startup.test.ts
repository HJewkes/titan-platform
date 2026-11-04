import { spawn } from 'node:child_process';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { captureStderr, waitForHealth, withStderr } from './child-startup.js';

const DYING_CHILD = "console.error('startup failed: Cannot find module ./missing.js'); process.exit(3)";

function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.createServer().listen(0, '127.0.0.1', () => {
      const addr = sock.address();
      sock.close(() => (typeof addr === 'object' && addr !== null ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

describe('child startup diagnostics', () => {
  it('fails fast naming the exit code and stderr when the server dies before /health', async () => {
    const child = spawn(process.execPath, ['-e', DYING_CHILD], { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr = captureStderr(child.stderr);

    const failure = waitForHealth(await unusedPort(), 15_000, child, stderr);

    await expect(failure).rejects.toThrow(/exited \(code 3\) before \/health answered.*Cannot find module \.\/missing\.js/s);
  });

  it('attaches the server stderr to a failed connect', async () => {
    const child = spawn(process.execPath, ['-e', DYING_CHILD], { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr = captureStderr(child.stderr);
    const closed = new Promise<never>((_, reject) => child.once('close', () => reject(new Error('Connection closed'))));

    await expect(withStderr(closed, stderr)).rejects.toThrow(/Connection closed; server stderr:\n.*Cannot find module/s);
  });
});
