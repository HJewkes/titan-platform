import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverTranscripts, type DiscoveredTranscript } from '@titan-design/session-read';
import { openGraph, type WorkspaceGraph } from './graph.js';
import { runRefresh } from './refresh.js';

/**
 * A pass over many dirty transcripts must hand the loop back between bounded
 * steps (TP-4172, TP-4175). The chunk between two yields is measured in rows
 * written, which a loaded runner cannot stretch the way it stretched the CPU
 * and wall-clock readings this file used to take (TP-4199, TP-4264). Sliced,
 * the longest chunk is one transcript's share of the pass, about 1/70 of its
 * rows; a pass that rolls every session up in one transaction holds most of
 * them in a single chunk.
 */

const TRANSCRIPTS = 60;
const EXCHANGES = 50;
/** No chunk may write more rows than this many transcripts' share of the pass. */
const MAX_CHUNK_TRANSCRIPTS = 4;

let corpus: string;
let transcripts: DiscoveredTranscript[];
let dir: string;
let graph: WorkspaceGraph;

function exchange(sessionId: string, n: number): Record<string, unknown>[] {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const requestId = `req-${sessionId}-${n}`;
  const common = { sessionId, cwd: '/synthetic', timestamp };
  return [
    { ...common, type: 'user', uuid: `u-${requestId}`, message: { role: 'user', content: `prompt ${n}` } },
    {
      ...common,
      type: 'assistant',
      uuid: `a-${requestId}`,
      requestId,
      message: {
        id: `msg-${requestId}`,
        role: 'assistant',
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'text', text: `answer ${n}` }],
      },
    },
  ];
}

function renderSession(sessionId: string): string {
  const lines: Record<string, unknown>[] = [];
  for (let n = 0; n < EXCHANGES; n += 1) lines.push(...exchange(sessionId, n));
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

beforeAll(async () => {
  corpus = mkdtempSync(path.join(os.tmpdir(), 'aw-pass-stall-corpus-'));
  mkdirSync(path.join(corpus, 'demo'));
  for (let i = 0; i < TRANSCRIPTS; i += 1) {
    writeFileSync(path.join(corpus, 'demo', `s${i}.jsonl`), renderSession(`sess-${i}`));
  }
  transcripts = await discoverTranscripts(corpus);
});

afterAll(() => {
  rmSync(corpus, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-pass-stall-'));
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
  vi.stubEnv('AGENT_CHAT_HOME', path.join(dir, 'agent-chat'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function totalChanges(): number {
  return (graph.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
}

/** Rows the pass writes between two of its yields, and before the first and after the last. */
async function measureChunks<T>(
  pass: (yieldPoint: () => Promise<void>) => Promise<T>,
): Promise<{ result: T; chunks: number[] }> {
  const chunks: number[] = [];
  let since = totalChanges();
  const sample = (): void => {
    const now = totalChanges();
    chunks.push(now - since);
    since = now;
  };
  const result = await pass(async () => {
    sample();
    await new Promise((resolve) => setImmediate(resolve));
  });
  sample();
  return { result, chunks };
}

function expectSliced(chunks: readonly number[]): void {
  const passRows = chunks.reduce((sum, rows) => sum + rows, 0);
  expect(passRows).toBeGreaterThan(TRANSCRIPTS * EXCHANGES);
  expect(Math.max(...chunks)).toBeLessThanOrEqual((passRows * MAX_CHUNK_TRANSCRIPTS) / TRANSCRIPTS);
}

function deltaPass(yieldPoint?: () => Promise<void>) {
  return runRefresh({ graph, mode: 'delta', transcripts, taskRoot: dir, skipWorkspace: true, yieldPoint });
}

describe('session index pass over 60 dirty transcripts', () => {
  it('a delta pass yields between transcripts and between sessions it rolls up', async () => {
    const { result, chunks } = await measureChunks(deltaPass);

    expect(result.indexed).toBe(TRANSCRIPTS);
    expect(result.turnsRolledUp).toBe(TRANSCRIPTS * EXCHANGES);
    expectSliced(chunks);
  });

  it('a pass resuming unfinished turns yields between sessions it rolls up', async () => {
    await deltaPass();
    // What a pass killed between its scan and its rollup leaves behind (TP-875).
    graph.db.prepare('UPDATE turn SET ended_at = NULL').run();

    const { result, chunks } = await measureChunks((yieldPoint) =>
      runRefresh({
        graph,
        root: corpus,
        taskRoot: dir,
        skipWorkspace: true,
        skipPrOutcomes: true,
        episodeSweep: false,
        yieldPoint,
      }),
    );

    expect(result.turnsRolledUp).toBe(TRANSCRIPTS * EXCHANGES);
    expect(graph.db.prepare('SELECT COUNT(*) AS n FROM turn WHERE ended_at IS NULL').get()).toEqual({ n: 0 });
    expectSliced(chunks);
  });

  it('a --full rebuild with an episode sweep yields between transcripts and sessions', async () => {
    const { result, chunks } = await measureChunks((yieldPoint) =>
      runRefresh({ graph, transcripts, full: true, taskRoot: dir, skipWorkspace: true, skipPrOutcomes: true, yieldPoint }),
    );

    expect(result.indexed).toBe(TRANSCRIPTS);
    expect(result.turnsRolledUp).toBe(TRANSCRIPTS * EXCHANGES);
    expectSliced(chunks);
  });
});
