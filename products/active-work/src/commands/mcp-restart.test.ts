/**
 * `mcp restart` must not report a pid it never confirmed (TP-36). A successor
 * spawned onto a port the predecessor still holds fails to bind and exits
 * silently, so the old code returned a pid that was already gone and left the
 * caller with no daemon at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { ChildProcess, spawn } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as paths from '../utils/paths.js';
import { writePidFile } from '../server/lifecycle.js';
import mcpRestart from './mcp-restart.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: vi.fn(() => ({ pid: SPAWNED_PID, unref: () => {} })),
}));

/** Must be a pid that is genuinely alive: restart now waits on the child, not just on `/health`. */
const SPAWNED_PID = process.pid;
/** Above macOS's pid ceiling, so `isProcessAlive` is false without racing a real process. */
const DEAD_PID = 999_999;

let tmp: string;
const hadPort = Object.prototype.hasOwnProperty.call(process.env, 'AW_PORT');
const prevPort = process.env.AW_PORT;

/** `probeHealth` is a bare fetch; null answers mean nothing is listening. */
function stubHealth(payload: unknown | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      payload === null
        ? Promise.reject(new Error('ECONNREFUSED'))
        : { ok: true, json: async () => payload },
    ),
  );
}

function run(): ReturnType<typeof mcpRestart.run> {
  return mcpRestart.run({}, { activeRoot: tmp, warnings: [], format: 'json' });
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'aw-mcp-restart-'));
  vi.spyOn(paths, 'getStateRoot').mockReturnValue(tmp);
  vi.mocked(spawn).mockClear();
  delete process.env.AW_PORT;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (hadPort) process.env.AW_PORT = prevPort;
  rmSync(tmp, { recursive: true, force: true });
});

describe('mcp restart', () => {
  it('reports the successor once it answers /health', async () => {
    await writePidFile(DEAD_PID, { port: 8123, version: '0.1.0', started: 'x' });
    stubHealth({ version: '0.1.0', pid: SPAWNED_PID, uptime_ms: 10, port: 8123 });

    await expect(run()).resolves.toEqual({ pid: SPAWNED_PID, port: 8123 });
  });

  it('fails loudly when the successor dies instead of reporting its pid', async () => {
    await writePidFile(DEAD_PID, { port: 8123, version: '0.1.0', started: 'x' });
    stubHealth(null);
    vi.mocked(spawn).mockReturnValueOnce(
      Object.assign(new ChildProcess(), { pid: DEAD_PID, unref: () => {} }),
    );

    await expect(run()).rejects.toThrow(/exited immediately/);
    expect(vi.mocked(spawn)).toHaveBeenCalledOnce();
  });

  it('reuses the recorded port rather than the default', async () => {
    await writePidFile(DEAD_PID, { port: 8123, version: '0.1.0', started: 'x' });
    stubHealth({ version: '0.1.0', pid: SPAWNED_PID, uptime_ms: 10, port: 8123 });

    await run();

    const args = vi.mocked(spawn).mock.calls[0]?.[1];
    expect(args).toEqual(expect.arrayContaining(['8123']));
  });

  describe('when stopping the current daemon would kill the caller (TP-83)', () => {
    const OLD_PID = 424_242;

    /** The old daemon is "alive" until SIGTERM, which ends this very call as it does through MCP. */
    function stubCallerKilledByStop(): void {
      let alive = true;
      vi.spyOn(process, 'kill').mockImplementation((pid: number, sig?: string | number) => {
        if (pid !== OLD_PID) return true;
        if (sig === 0) {
          if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
          return true;
        }
        alive = false;
        throw new Error('caller terminated with the daemon');
      });
    }

    it('spawns the successor before it stops the old daemon', async () => {
      await writePidFile(OLD_PID, { port: 8123, version: '0.1.0', started: 'x' });
      stubCallerKilledByStop();
      stubHealth(null);

      await run().catch(() => undefined);

      expect(vi.mocked(spawn)).toHaveBeenCalledOnce();
    });

    it('hands the successor the old pid to wait for and the port to bind', async () => {
      await writePidFile(OLD_PID, { port: 8123, version: '0.1.0', started: 'x' });
      stubCallerKilledByStop();
      stubHealth(null);

      await run().catch(() => undefined);

      expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(
        expect.arrayContaining([String(OLD_PID), '8123']),
      );
    });
  });

  it('tells the caller to start the daemon manually when the successor never listens', async () => {
    vi.useFakeTimers();
    await writePidFile(DEAD_PID, { port: 8123, version: '0.1.0', started: 'x' });
    stubHealth(null);

    const state = { settled: false };
    const outcome = run().then(
      () => undefined,
      (err: Error) => err,
    ).finally(() => {
      state.settled = true;
    });
    // File reads inside run() are real I/O, so the clock must keep advancing until it settles.
    while (!state.settled) await vi.advanceTimersByTimeAsync(1_000);

    expect((await outcome)?.message).toMatch(/mcp serve --detach/);
  });
});
