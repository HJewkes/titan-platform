/**
 * Integration test: spawn a real daemon from dist, drive HTTP +
 * MCP-over-HTTP against it, then SIGTERM and check the PID file is gone.
 */
import { describe, it, expect } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { waitForHealth } from './child-startup.js';
import {
  findDaemonPidFile,
  findFreePort,
  spawnDaemon,
  waitForExit,
  type SpawnedDaemon,
} from './daemon-harness.js';

/** A pid high enough that nothing on the box owns it. */
const SUCCESSOR_PID = 999_999;

interface HealthPayload {
  ok: boolean;
  pid: number;
  port: number;
}

/**
 * Poll `/health` until it answers 200 and return the payload.
 *
 * The daemon answers 503 until its PID file is on disk, so a 200 is the
 * signal that the whole startup handoff — port bound *and* PID file filed —
 * has completed.
 */
async function waitForHealthPayload(port: number, timeoutMs: number, daemon: SpawnedDaemon): Promise<HealthPayload> {
  const res = await waitForHealth(port, timeoutMs, daemon.child, daemon.stderr);
  return (await res.json()) as HealthPayload;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Wait for the pid itself to be gone, not only for the child's exit event. */
async function waitForDaemonExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`daemon pid ${pid} still alive after ${timeoutMs}ms`);
}

/** SIGTERM the pid /health reported, so the test signals the process that filed the PID file. */
async function terminateDaemon(child: ChildProcess, daemonPid: number): Promise<void> {
  process.kill(daemonPid, 'SIGTERM');
  await waitForExit(child, 10_000);
  await waitForDaemonExit(daemonPid, 10_000);
}

describe('integration: daemon over HTTP', () => {
  it('serves /health, /rpc/list, and /mcp; cleans up the PID file on shutdown', async () => {
    const port = await findFreePort();
    const stateRoot = mkdtempSync(path.join(tmpdir(), 'aw-daemon-int-'));
    const activeRoot = mkdtempSync(path.join(tmpdir(), 'aw-daemon-int-data-'));

    const daemon = spawnDaemon(port, stateRoot, activeRoot);
    const { child } = daemon;
    let daemonPid = 0;

    try {
      daemonPid = (await waitForHealthPayload(port, 15_000, daemon)).pid;

      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as { ok: boolean; port: number };
      expect(health.ok).toBe(true);
      expect(health.port).toBe(port);

      const rpcRes = await fetch(`http://127.0.0.1:${port}/rpc/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-titan-client': 'test' },
        body: '{}',
      });
      expect(rpcRes.status).toBe(200);
      const rpc = (await rpcRes.json()) as { ok: boolean; data?: { sections: unknown } };
      expect(rpc.ok).toBe(true);
      expect(rpc.data?.sections).toBeDefined();

      // MCP-over-HTTP: tools/list
      const mcpRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-titan-client': 'test',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });
      expect(mcpRes.ok).toBe(true);
      // Response may be JSON or an SSE stream; handle both.
      const text = await mcpRes.text();
      let parsed: { result?: { tools?: unknown[] } };
      if (text.startsWith('{')) {
        parsed = JSON.parse(text) as typeof parsed;
      } else {
        const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
        expect(dataLine).toBeDefined();
        parsed = JSON.parse(dataLine!.slice('data:'.length).trim()) as typeof parsed;
      }
      expect(Array.isArray(parsed.result?.tools)).toBe(true);
      expect(parsed.result!.tools!.length).toBeGreaterThanOrEqual(35);
    } finally {
      if (daemonPid > 0) await terminateDaemon(child, daemonPid);
      else child.kill('SIGKILL');
      // The PID file should be cleaned up by the daemon's signal handler.
      // env-paths on Linux: <XDG_STATE_HOME>/active-work/daemon.pid
      // on macOS: ~/Library/Logs/active-work/daemon.pid (using HOME override)
      // Just assert no daemon.pid file remains under any state location.
      const lingering = findDaemonPidFile(stateRoot);
      expect(lingering).toBeNull();
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(activeRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('leaves a successor PID file in place on shutdown (AW-76)', async () => {
    const port = await findFreePort();
    const stateRoot = mkdtempSync(path.join(tmpdir(), 'aw-daemon-succ-'));
    const activeRoot = mkdtempSync(path.join(tmpdir(), 'aw-daemon-succ-data-'));
    const daemon = spawnDaemon(port, stateRoot, activeRoot);
    const { child } = daemon;

    try {
      const health = await waitForHealthPayload(port, 15_000, daemon);
      const pidFile = findDaemonPidFile(stateRoot);
      expect(pidFile).not.toBeNull();
      // A 200 means the daemon filed itself, so the file must already name it.
      // Asserting that here pins the startup handoff rather than assuming it.
      expect(readFileSync(pidFile!, 'utf8').trim()).toBe(String(health.pid));

      // Stand in for a launchd successor that filed itself before this
      // instance's SIGTERM handler ran. Written the same way the daemon writes
      // it — staged and renamed — so the stand-in cannot itself interleave.
      writeSuccessorPidFile(pidFile!);

      await terminateDaemon(child, health.pid);

      expect(findDaemonPidFile(stateRoot)).toBe(pidFile);
      expect(readFileSync(pidFile!, 'utf8').trim()).toBe(String(SUCCESSOR_PID));
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(activeRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

function writeSuccessorPidFile(pidFile: string): void {
  const tmp = `${pidFile}.successor.tmp`;
  writeFileSync(tmp, String(SUCCESSOR_PID), 'utf8');
  renameSync(tmp, pidFile);
}
