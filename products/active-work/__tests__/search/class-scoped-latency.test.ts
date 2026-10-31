import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { graphNoteRelevance } from '../../src/bootstrap/rank-notes.js';
import { relatedContext } from '../../src/search/related.js';
import { meaningfulTerms, orExpression } from '../../src/search/terms.js';
import { workspaceSpanReader } from '../../src/search/workspace-spans.js';
import { openGraph } from '../../src/session-index/graph.js';
import { refreshInto, scaffold } from '../workspace-index/fixture.js';

/**
 * A latency guard for class-scoped search on a transcript-heavy graph (TP-1960).
 *
 * FTS5 bm25-ranks every span a query matches before the class filter applies,
 * so a note query whose terms are common in transcripts costs what those terms
 * match corpus-wide. The live graph is 92% transcript spans; this fixture
 * reproduces that shape synthetically: a small workspace plus 500k transcript
 * spans that all carry the common words a loop label is full of.
 *
 * Both checks compare against the same query run uncapped on the same graph,
 * so a slow machine moves both sides and the ratio stays meaningful; the
 * absolute ceiling is the done_when's 100 ms with headroom for a loaded runner.
 */

// 1M spans took ~36 s to seed and ~60 s overall, past the CI budget; 500k keeps the ratio asserts meaningful.
const TRANSCRIPT_SPANS = 500_000;
const COMMON = ['agent', 'now', 'next', 'its', 'work', 'session'];
const FILLER = ['tool', 'output', 'result', 'call', 'line', 'file', 'read', 'wrote'];
const LOOP_TEXT = 'agent now next its work session: the alpha lesson for the indexer';
const CLASSES = ['notes', 'sources', 'tasks', 'sessions'];
const RUNS = 5;
const WIDE_OR = [...COMMON, ...FILLER].join(' OR ');
const CEILING_MS = 100;
const MIN_SPEEDUP = 3;

let dir: string;
let root: string;
let dbPath: string;

function transcriptText(i: number): string {
  const filler = FILLER.filter((_, j) => (i + j) % 3 === 0).join(' ');
  return `${COMMON.join(' ')} ${filler} token${i % 997}`;
}

function seedTranscripts(): void {
  const graph = openGraph(dbPath);
  try {
    graph.db.transaction(() => {
      for (let i = 0; i < TRANSCRIPT_SPANS; i++) {
        const span = { ownerRef: `session:synthetic-${i % 500}`, field: 'tool_result', sourceId: 1, byteOffset: i, byteLength: 1 };
        graph.spans.index(span, transcriptText(i));
      }
    })();
  } finally {
    graph.db.close();
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function timed(run: () => unknown): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

async function medianMs(run: () => unknown): Promise<number> {
  await run();
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) samples.push(await timed(run));
  return median(samples);
}

/** The pre-TP-1960 note query: every subject term OR'd, ranked corpus-wide before the scope. */
function uncappedNoteQuery(): void {
  const graph = openGraph(dbPath);
  try {
    graph.spans.search(orExpression(meaningfulTerms(LOOP_TEXT)), 300, { ownerPrefix: 'note:' });
  } finally {
    graph.db.close();
  }
}

/** The ceiling that fails if workspace search runs against the transcript table. */
function workspaceOrQuery(): number {
  const graph = openGraph(dbPath);
  try {
    return workspaceSpanReader(graph).search(WIDE_OR, 300, { ownerPrefix: 'note:' }).length;
  } finally {
    graph.db.close();
  }
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-latency-'));
  root = path.join(dir, 'active');
  dbPath = path.join(dir, 'graph.sqlite3');
  scaffold(root);
  (await refreshInto(dbPath, root)).db.close();
  seedTranscripts();
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('class-scoped search on a transcript-heavy graph', () => {
  it('answers a note-scoped query under the ceiling and well under the uncapped query', async () => {
    const relevance = graphNoteRelevance(dbPath);
    const terms = meaningfulTerms(LOOP_TEXT);

    const capped = await medianMs(() => relevance(terms));
    const uncapped = await medianMs(uncappedNoteQuery);

    expect(capped).toBeLessThan(CEILING_MS);
    expect(uncapped / capped).toBeGreaterThan(MIN_SPEEDUP);
  }, 60_000);

  it('answers each class of a loop retrieval under the ceiling, still finding the note', async () => {
    const uncapped = await medianMs(uncappedNoteQuery);
    for (const cls of CLASSES) {
      const run = () => relatedContext({ text: LOOP_TEXT, classes: [cls], dbPath, activeRoot: root });

      const ms = await medianMs(run);

      expect(ms, cls).toBeLessThan(CEILING_MS);
      expect(uncapped / ms, cls).toBeGreaterThan(MIN_SPEEDUP);
    }
    const notes = await relatedContext({ text: LOOP_TEXT, classes: ['notes'], dbPath, activeRoot: root });
    expect(notes.query.terms).toContain('agent');
    expect(notes.hits.map((hit) => hit.ref)).toContain('note:alpha/2026-09-02-alpha-lesson.md');
  }, 60_000);

  it('answers a 14-term OR on the workspace table under the ceiling while the transcript table is far slower', async () => {
    const wide = await medianMs(workspaceOrQuery);
    const onTranscripts = await medianMs(() => {
      const graph = openGraph(dbPath);
      try {
        graph.spans.search(WIDE_OR, 300, { ownerPrefix: 'note:' });
      } finally {
        graph.db.close();
      }
    });

    expect(wide).toBeLessThan(CEILING_MS);
    expect(onTranscripts / wide).toBeGreaterThan(MIN_SPEEDUP);
  }, 60_000);
});
