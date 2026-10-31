import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DF_CAP_FLOOR } from '../../src/search/derive-query.js';
import {
  countMatches,
  ftsTokens,
  graphDocumentFrequency,
  graphTermStatistics,
} from '../../src/search/document-frequency.js';
import { openGraph, type SessionGraph } from '../../src/session-index/graph.js';

let dir: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-df-'));
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
});

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function indexSpans(word: string, count: number): void {
  graph.db.transaction(() => indexEach(word, count))();
}

function indexEach(word: string, count: number): void {
  for (let i = 0; i < count; i++) {
    graph.spans.index(
      {
        ownerRef: `session:${word}-${i}`,
        field: 'text',
        sourceId: 1,
        byteOffset: i,
        byteLength: 1,
      },
      `${word} filler`,
    );
  }
}

describe('countMatches', () => {
  it('counts every match when the term has fewer than the cap', () => {
    indexSpans('rare', 3);
    indexSpans('other', 4);

    expect(countMatches(graph as never, '"rare"', 10)).toBe(3);
  });

  it('stops at the cap when the term has more matches than it', () => {
    indexSpans('common', 15);

    expect(countMatches(graph as never, '"common"', 10)).toBe(10);
  });
});

describe('graphDocumentFrequency', () => {
  it('reads a common term past the exact-count cap from the FTS vocabulary', () => {
    indexSpans('common', 2500);

    expect(graphDocumentFrequency(graph as never)('common')).toBe(2500);
  });

  it('counts a rare term exactly, leaving out spans that were purged', () => {
    indexSpans('rare', 4);
    graph.spans.purgeOwner('session:rare-0');

    expect(graphDocumentFrequency(graph as never)('rare')).toBe(3);
  });

  it('bounds a phrase term by its rarest token', () => {
    indexSpans('alpha_beta', 2);

    expect(graphDocumentFrequency(graph as never)('alpha_beta')).toBe(2);
  });

  it('reads zero for a term the corpus never saw', () => {
    indexSpans('present', 2);

    expect(graphDocumentFrequency(graph as never)('absent')).toBe(0);
  });
});

describe('graphTermStatistics', () => {
  it('caps terms at the floor on a small graph', () => {
    indexSpans('word', 10);

    expect(graphTermStatistics(graph as never).maxDf).toBe(DF_CAP_FLOOR);
  });
});

describe('ftsTokens', () => {
  it('splits on what the unicode61 tokenizer splits on and folds diacritics', () => {
    expect(ftsTokens('Café_au-lait')).toEqual(['cafe', 'au', 'lait']);
  });
});
