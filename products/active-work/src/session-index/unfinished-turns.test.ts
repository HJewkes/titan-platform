import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverTranscripts } from '@titan-design/session-read';
import { openGraph, type WorkspaceGraph } from './graph.js';
import { runRefresh } from './refresh.js';
import { rollupUnfinishedTurns, rollupYielding } from './unfinished-turns.js';

const SESSIONS = ['sess-a', 'sess-b', 'sess-c'];

let dir: string;
let graph: WorkspaceGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-unfinished-turns-'));
  mkdirSync(path.join(dir, 'projects', 'demo'), { recursive: true });
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
  vi.stubEnv('AGENT_CHAT_HOME', path.join(dir, 'agent-chat'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function promptLine(sessionId: string): string {
  return `${JSON.stringify({
    type: 'user',
    sessionId,
    uuid: `u-${sessionId}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: 'go' },
  })}\n`;
}

/** Indexed sessions whose turns read as a pass killed before its rollup left them. */
async function unfinishedSessions(): Promise<void> {
  for (const id of SESSIONS) {
    writeFileSync(path.join(dir, 'projects', 'demo', `${id}.jsonl`), promptLine(id));
  }
  const transcripts = await discoverTranscripts(path.join(dir, 'projects'));
  await runRefresh({ graph, mode: 'delta', transcripts, taskRoot: dir, skipWorkspace: true });
  graph.db.prepare('UPDATE turn SET ended_at = NULL').run();
}

const unfinishedTurns = (): unknown =>
  graph.db.prepare('SELECT COUNT(*) AS n FROM turn WHERE ended_at IS NULL').get();

describe('sliced rollup', () => {
  it('an abort at a yield point still rolls up the sessions after it', async () => {
    await unfinishedSessions();
    const abort = new Error('shutting down');

    await expect(
      rollupYielding(graph, SESSIONS, () => Promise.reject(abort)),
    ).rejects.toBe(abort);

    expect(unfinishedTurns()).toEqual({ n: 0 });
  });

  it('yields once per session', async () => {
    await unfinishedSessions();
    let yields = 0;

    const updated = await rollupYielding(graph, [...SESSIONS, 'sess-a'], async () => {
      yields += 1;
    });

    expect(updated).toBe(SESSIONS.length);
    expect(yields).toBe(SESSIONS.length);
    expect(unfinishedTurns()).toEqual({ n: 0 });
  });

  it('gathers unfinished turns a page at a time, yielding after each page', async () => {
    await unfinishedSessions();
    let yields = 0;

    const updated = await rollupUnfinishedTurns(
      graph,
      async () => {
        yields += 1;
      },
      1,
    );

    expect(updated).toBe(SESSIONS.length);
    expect(yields).toBe(SESSIONS.length * 2);
    expect(unfinishedTurns()).toEqual({ n: 0 });
  });
});
