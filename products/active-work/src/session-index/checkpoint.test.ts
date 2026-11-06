import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverTranscripts, type DiscoveredTranscript } from '@titan-design/session-read';
import { startCheckpointer } from './checkpoint.js';
import { openGraph, type WorkspaceGraph } from './graph.js';
import { runRefresh } from './refresh.js';

/**
 * SQLite gives JS no hook on fsync, so the test slows the one checkpoint path
 * the daemon owns, the worker's, to 1.5 s. The paths it cannot slow,
 * the autocheckpoint and the per-commit WAL sync, must be off on the loop's
 * connection, which the pragma case pins.
 */

const TRANSCRIPTS = 60;
const EXCHANGES = 100;
const SLOW_FSYNC_MS = 1_500;
const SLOW_FIXTURE = { timeout: 120_000 };

let dir: string;
let graph: WorkspaceGraph;

function sessionLines(sessionId: string): string {
  const lines: Record<string, unknown>[] = [];
  for (let n = 0; n < EXCHANGES; n += 1) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
    const requestId = `req-${sessionId}-${n}`;
    const common = { sessionId, cwd: '/synthetic', timestamp };
    lines.push(
      { ...common, type: 'user', uuid: `u-${requestId}`, message: { role: 'user', content: `prompt ${n}` } },
      {
        ...common,
        type: 'assistant',
        uuid: `a-${requestId}`,
        requestId,
        message: { id: `msg-${requestId}`, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: `answer ${n}` }] },
      },
    );
  }
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

async function writeCorpus(): Promise<DiscoveredTranscript[]> {
  const corpus = path.join(dir, 'corpus');
  mkdirSync(path.join(corpus, 'demo'), { recursive: true });
  for (let i = 0; i < TRANSCRIPTS; i += 1) {
    writeFileSync(path.join(corpus, 'demo', `s${i}.jsonl`), sessionLines(`sess-${i}`));
  }
  return discoverTranscripts(corpus);
}

/** Rows reach the database file only through a checkpoint; until then they sit in the WAL. */
function databaseFileBytes(): number {
  return statSync(graph.db.name).size;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-checkpoint-'));
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
  vi.stubEnv('AGENT_CHAT_HOME', path.join(dir, 'agent-chat'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('index checkpoints run off the event loop', () => {
  it('the loop connection neither autocheckpoints nor syncs each commit', async () => {
    graph.db.pragma('synchronous = FULL');

    const checkpointer = startCheckpointer(graph.db);

    expect(graph.db.pragma('wal_autocheckpoint', { simple: true })).toBe(0);
    expect(graph.db.pragma('synchronous', { simple: true })).toBe(1);
    await checkpointer.stop();
  });

  it('the loop keeps turning while a checkpoint is in flight in the worker', SLOW_FIXTURE, async () => {
    // Counting loop turns inside the worker's slow checkpoint, rather than timing the
    // pass, makes the check independent of runner speed: a checkpoint that blocked the
    // loop would leave no turn between its start and end reports.
    let inFlight = false;
    let turnsInFlight = 0;
    let running = true;
    const waiters: Array<(phase: 'start' | 'end') => void> = [];
    const nextPhase = (): Promise<'start' | 'end'> => new Promise((resolve) => waiters.push(resolve));
    const checkpointer = startCheckpointer(graph.db, {
      intervalMs: 50,
      simulatedFsyncMs: SLOW_FSYNC_MS,
      onCheckpoint: (phase) => {
        inFlight = phase === 'start';
        for (const waiter of waiters.splice(0)) waiter(phase);
      },
    });
    const pump = (async () => {
      while (running) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (inFlight) turnsInFlight += 1;
      }
    })();
    const transcripts = await writeCorpus();
    const bytesBefore = databaseFileBytes();

    const result = await runRefresh({ graph, mode: 'delta', transcripts, taskRoot: dir, skipWorkspace: true });
    while ((await nextPhase()) !== 'start');
    turnsInFlight = 0;
    while ((await nextPhase()) !== 'end');
    running = false;
    await pump;
    await checkpointer.stop();

    expect(result.indexed).toBe(TRANSCRIPTS);
    expect(turnsInFlight).toBeGreaterThan(0);
    expect(databaseFileBytes()).toBeGreaterThan(bytesBefore);
  });

  it('a worker that fails hands checkpointing back to the connection', async () => {
    const onError = vi.fn();
    const checkpointer = startCheckpointer(graph.db, { driver: path.join(dir, 'missing.js'), onError });

    await checkpointer.stop();

    expect(onError).toHaveBeenCalledOnce();
    expect(graph.db.pragma('wal_autocheckpoint', { simple: true })).toBe(1_000);
  });
});
