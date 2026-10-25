import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverTranscripts, type DiscoveredTranscript } from '@titan-design/session-read';
import { measureLoopStall } from '../server/session-index-watch.js';
import { openGraph, type WorkspaceGraph } from './graph.js';
import { runRefresh } from './refresh.js';

/**
 * A pass over 500 dirty transcripts, measured the way the daemon logs it. On
 * main's source the rollup ran as one synchronous transaction and stalled the
 * loop about 3 s on this fixture; sliced, the longest stall is tens of
 * milliseconds. The 1 s bound is the plan's, and leaves more than 10x headroom
 * above the sliced stall for a loaded runner.
 */

const TRANSCRIPTS = 500;
const EXCHANGES = 150;
const STALL_BOUND_MS = 1_000;
const SLOW_FIXTURE = { timeout: 600_000 };

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

function deltaPass() {
  return runRefresh({ graph, mode: 'delta', transcripts, taskRoot: dir, skipWorkspace: true });
}

describe('session index pass over 500 dirty transcripts', () => {
  it('a delta pass never stalls the event loop for a second', SLOW_FIXTURE, async () => {
    const { result, maxStallMs } = await measureLoopStall(deltaPass);

    expect(result.indexed).toBe(TRANSCRIPTS);
    expect(result.turnsRolledUp).toBe(TRANSCRIPTS * EXCHANGES);
    expect(maxStallMs).toBeLessThanOrEqual(STALL_BOUND_MS);
  });

  it('a pass resuming unfinished turns never stalls the event loop for a second', SLOW_FIXTURE, async () => {
    await deltaPass();
    // What a pass killed between its scan and its rollup leaves behind (TP-875).
    graph.db.prepare('UPDATE turn SET ended_at = NULL').run();

    const { result, maxStallMs } = await measureLoopStall(() =>
      runRefresh({
        graph,
        root: corpus,
        taskRoot: dir,
        skipWorkspace: true,
        skipPrOutcomes: true,
        episodeSweep: false,
      }),
    );

    expect(result.turnsRolledUp).toBe(TRANSCRIPTS * EXCHANGES);
    expect(graph.db.prepare('SELECT COUNT(*) AS n FROM turn WHERE ended_at IS NULL').get()).toEqual({ n: 0 });
    expect(maxStallMs).toBeLessThanOrEqual(STALL_BOUND_MS);
  });
});
