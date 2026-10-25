import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoverTranscripts, type DiscoveredTranscript } from '@titan-design/session-read';
import { openGraph, type WorkspaceGraph } from './graph.js';
import { runRefresh } from './refresh.js';

/**
 * A pass over 500 dirty transcripts. Run as one synchronous transaction, the
 * rollup held the loop about 2.5 s on this fixture; sliced, the longest chunk
 * is 80 to 250 ms. The 1 s bound is the plan's: well above the sliced chunk,
 * and 2.5x below the unsliced one for a fast machine.
 */

const TRANSCRIPTS = 500;
const EXCHANGES = 250;
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
  // Each WAL autocheckpoint fsyncs twice inside a commit on this thread. A
  // contended CI disk made that 2 to 3 s, so the bound measured the runner's
  // disk instead of the pass's own synchronous chunks (TP-4200).
  graph.db.pragma('synchronous = OFF');
  vi.stubEnv('AGENT_CHAT_HOME', path.join(dir, 'agent-chat'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The longest synchronous chunk `fn` holds the loop for, in this thread's CPU
 * time. The daemon logs wall-clock loop delay (`measureLoopStall`), but on a
 * loaded CI runner that also counts time the OS keeps the thread off the CPU:
 * chunks of about 250 ms read as 2.6 to 3.3 s stalls there (TP-4199). A timer
 * fires between chunks, so the CPU time spent between two firings is at most
 * one chunk plus the sub-millisecond work around it.
 *
 * GC pauses in each interval are subtracted. A threads-pool worker's heap
 * still holds garbage from the files it ran before this one, so a major GC
 * there costs the heap's size, not the pass's. On CI a resume pass read 1348 ms
 * where it reads under 30 ms with no GC locally.
 */
async function measureLongestChunk<T>(fn: () => Promise<T>): Promise<{ result: T; maxChunkMs: number }> {
  const intervals: CpuInterval[] = [];
  const gcs: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => gcs.push(...list.getEntries()));
  observer.observe({ entryTypes: ['gc'] });
  let since = process.threadCpuUsage();
  let sinceAt = performance.now();
  const sample = (): void => {
    const spent = process.threadCpuUsage(since);
    const now = performance.now();
    intervals.push({ start: sinceAt, end: now, cpuMs: (spent.user + spent.system) / 1_000 });
    since = process.threadCpuUsage();
    sinceAt = now;
  };
  const timer = setInterval(sample, 1);
  try {
    const result = await fn();
    sample();
    // Node queues a GC's entry on the loop after the pause, so let the last ones land.
    await new Promise((resolve) => setImmediate(resolve));
    gcs.push(...observer.takeRecords());
    const chunks = intervals.map((interval) => interval.cpuMs - gcMsWithin(gcs, interval));
    return { result, maxChunkMs: Math.round(Math.max(0, ...chunks)) };
  } finally {
    clearInterval(timer);
    observer.disconnect();
  }
}

interface CpuInterval {
  start: number;
  end: number;
  cpuMs: number;
}

function gcMsWithin(gcs: readonly PerformanceEntry[], { start, end }: CpuInterval): number {
  let ms = 0;
  for (const gc of gcs) ms += Math.max(0, Math.min(end, gc.startTime + gc.duration) - Math.max(start, gc.startTime));
  return ms;
}

function deltaPass() {
  return runRefresh({ graph, mode: 'delta', transcripts, taskRoot: dir, skipWorkspace: true });
}

describe('session index pass over 500 dirty transcripts', () => {
  it('a delta pass never stalls the event loop for a second', SLOW_FIXTURE, async () => {
    const { result, maxChunkMs } = await measureLongestChunk(deltaPass);

    expect(result.indexed).toBe(TRANSCRIPTS);
    expect(result.turnsRolledUp).toBe(TRANSCRIPTS * EXCHANGES);
    expect(maxChunkMs).toBeLessThanOrEqual(STALL_BOUND_MS);
  });

  it('a pass resuming unfinished turns never stalls the event loop for a second', SLOW_FIXTURE, async () => {
    await deltaPass();
    // What a pass killed between its scan and its rollup leaves behind (TP-875).
    graph.db.prepare('UPDATE turn SET ended_at = NULL').run();

    const { result, maxChunkMs } = await measureLongestChunk(() =>
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
    expect(maxChunkMs).toBeLessThanOrEqual(STALL_BOUND_MS);
  });
});
