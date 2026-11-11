/**
 * TP-5189 / TP-5190: the restart successor is a real script, so these tests run
 * it for real (against a stand-in entrypoint) rather than mocking the spawn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import * as paths from '../utils/paths.js';
import { writePidFile } from '../server/lifecycle.js';
import mcpRestart, { SUCCESSOR_SCRIPT } from './mcp-restart.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof ChildProcessModule>();
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock };
});

const DEAD_PID = 999_999;
const HARD_TIMEOUT_MS = 20_000;

let tmp: string;
const started: ChildProcess[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no ephemeral port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function startProcess(args: string[]): ChildProcess {
  const child = realSpawn(process.execPath, args, { stdio: 'ignore' });
  started.push(child);
  return child;
}

async function until(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'aw-mcp-successor-'));
  vi.spyOn(paths, 'getStateRoot').mockReturnValue(tmp);
});

afterEach(() => {
  for (const child of started) if (child.exitCode === null) child.kill('SIGKILL');
  started.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('restart successor script', () => {
  it(
    'waits for the predecessor pid to exit before starting mcp serve',
    async () => {
      const marker = path.join(tmp, 'served.json');
      const entry = path.join(tmp, 'fake-entry.cjs');
      writeFileSync(
        entry,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ at: Date.now(), argv: process.argv.slice(2) }));`,
      );
      const port = await freePort();
      const dummy = startProcess(['-e', 'setTimeout(() => {}, 1500)']);
      const dummyExited = new Promise<number>((resolve) =>
        dummy.once('exit', () => resolve(Date.now())),
      );

      startProcess(['-e', SUCCESSOR_SCRIPT, String(dummy.pid), entry, String(port)]);
      await new Promise((r) => setTimeout(r, 700));
      expect(existsSync(marker)).toBe(false);
      // The dummy is still running here (its exit event has not fired), so the
      // successor may not serve before this moment.
      const knownRunningAt = Date.now();

      await dummyExited;
      expect(await until(() => existsSync(marker), 10_000)).toBe(true);
      const served = z
        .object({ at: z.number(), argv: z.array(z.string()) })
        .parse(JSON.parse(readFileSync(marker, 'utf8')));
      expect(served.at).toBeGreaterThanOrEqual(knownRunningAt);
      expect(served.argv).toEqual(['mcp', 'serve', '--port', String(port)]);
    },
    HARD_TIMEOUT_MS,
  );
});

describe('mcp restart pid (TP-5189)', () => {
  it('reports the serving daemon pid from /health, not the wrapper pid', async () => {
    const port = await freePort();
    const servingPid = process.pid + 1;
    await writePidFile(DEAD_PID, { port, version: '0.1.0', started: 'x' });
    // The wrapper stays alive for the whole check, as the real one does while serving.
    const wrapper = startProcess(['-e', 'setTimeout(() => {}, 10000)']);
    spawnMock.mockReturnValueOnce({ pid: wrapper.pid, unref: () => {} });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ version: '0.1.0', pid: servingPid, uptime_ms: 1, port }),
      })),
    );

    const result = await mcpRestart.run({}, { activeRoot: tmp, warnings: [], format: 'json' });

    expect(result).toEqual({ pid: servingPid, port });
    expect(result.pid).not.toBe(wrapper.pid);
  }, HARD_TIMEOUT_MS);
});
