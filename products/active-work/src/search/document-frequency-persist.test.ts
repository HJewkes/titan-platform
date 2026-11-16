import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openGraph, type WorkspaceGraph } from '../session-index/graph.js';

type FrequencyModule = typeof import('./document-frequency.js');

let dir: string;
let graph: WorkspaceGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-df-persist-'));
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
  indexSpans('common', 2500);
  indexSpans('rare', 4);
});

afterEach(() => {
  vi.restoreAllMocks();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function indexSpans(word: string, count: number, from = 0): void {
  graph.db.transaction(() => {
    for (let i = from; i < from + count; i++) {
      graph.spans.index(
        { ownerRef: `session:${word}-${i}`, field: 'text', sourceId: 1, byteOffset: i, byteLength: 1 },
        `${word} filler`,
      );
    }
  })();
}

/** A fresh module instance stands in for a second process: no in-memory counts carry over. */
async function freshProcess(): Promise<FrequencyModule> {
  vi.resetModules();
  return import('./document-frequency.js');
}

/** Every statement that reads a count off the index rather than off the persisted store. */
function spyIndexLookups(): string[] {
  const lookups: string[] = [];
  const prepare = graph.db.prepare.bind(graph.db);
  vi.spyOn(graph.db, 'prepare').mockImplementation(((sql: string) => {
    if (/_vocab|MATCH/.test(sql)) lookups.push(sql);
    return prepare(sql);
  }) as typeof graph.db.prepare);
  return lookups;
}

async function countInEarlierProcess(terms: string[]): Promise<number[]> {
  const earlier = await freshProcess();
  const frequency = earlier.graphDocumentFrequency(graph);
  const counts = terms.map((term) => frequency(term));
  earlier.persistDocumentFrequency();
  return counts;
}

const sidecar = (): string => `${graph.db.name}-df.json`;

describe('document frequency persisted across processes', () => {
  it('reuses counts an earlier process persisted without querying the index', async () => {
    const earlier = await countInEarlierProcess(['common', 'rare']);
    const later = await freshProcess();
    const lookups = spyIndexLookups();

    const counts = ['common', 'rare'].map((term) => later.graphDocumentFrequency(graph)(term));

    expect(counts).toEqual(earlier);
    expect(lookups).toEqual([]);
  });

  it('recounts a term after spans are indexed since the counts were persisted', async () => {
    await countInEarlierProcess(['rare']);
    indexSpans('rare', 3, 4);
    const later = await freshProcess();

    expect(later.graphDocumentFrequency(graph)('rare')).toBe(7);
  });

  it('recounts a term after a pass that purged spans clears the counts', async () => {
    await countInEarlierProcess(['rare']);
    graph.spans.purgeOwner('session:rare-0');
    const later = await freshProcess();
    later.clearDocumentFrequency(graph.db.name);

    expect(later.graphDocumentFrequency(graph)('rare')).toBe(3);
  });

  it('falls back to live counts when the persisted file is corrupt', async () => {
    const live = await countInEarlierProcess(['common', 'rare']);
    writeFileSync(sidecar(), '{"v":1,"stamp":');
    const later = await freshProcess();
    const lookups = spyIndexLookups();

    const counts = ['common', 'rare'].map((term) => later.graphDocumentFrequency(graph)(term));

    expect(counts).toEqual(live);
    expect(lookups.length).toBeGreaterThan(0);
  });

  it('falls back to live counts when the persisted file holds a non-count value', async () => {
    const live = await countInEarlierProcess(['rare']);
    const stored = JSON.parse(readFileSync(sidecar(), 'utf8')) as Record<string, unknown>;
    writeFileSync(sidecar(), JSON.stringify({ ...stored, terms: { rare: 'many' } }));
    const later = await freshProcess();

    expect(later.graphDocumentFrequency(graph)('rare')).toBe(live[0]);
  });

  it('counts live when no earlier process persisted anything', async () => {
    const later = await freshProcess();
    const lookups = spyIndexLookups();

    expect(later.graphDocumentFrequency(graph)('common')).toBe(2500);
    expect(lookups.length).toBeGreaterThan(0);
  });
});
