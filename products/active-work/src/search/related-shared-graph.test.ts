import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraph } from '../session-index/graph.js';
import { writeCharter } from '../test-support/visibility.js';
import { refreshInto, scaffold } from '../test-support/workspace-index/fixture.js';
import { relatedContext, type RelatedInput } from './related.js';

/** A caller running many queries passes one open graph; `relatedContext` must leave it open (TP-6295). */

let dir: string;
let root: string;
let dbPath: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-related-shared-'));
  root = path.join(dir, 'active');
  dbPath = path.join(dir, 'graph.sqlite3');
  scaffold(root);
  writeCharter(root);
  (await refreshInto(dbPath, root)).db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const related = (input: Partial<RelatedInput> & { text: string }) =>
  relatedContext({ dbPath, activeRoot: root, ...input });

describe('relatedContext with a passed graph', () => {
  it('leaves the passed graph open and answers as it would from the path', async () => {
    const graph = openGraph(dbPath);
    try {
      const viaPath = await related({ text: 'the alpha lesson', initiative: 'alpha' });

      const viaGraph = await related({ text: 'the alpha lesson', initiative: 'alpha', graph });

      expect(graph.db.open).toBe(true);
      expect(viaGraph.hits).toEqual(viaPath.hits);
    } finally {
      graph.db.close();
    }
  });

  it('reads a passed graph even when the path names no file', async () => {
    const graph = openGraph(dbPath);
    try {
      const result = await related({
        text: 'the alpha lesson',
        initiative: 'alpha',
        graph,
        dbPath: path.join(dir, 'absent.sqlite3'),
      });

      // The fixture has no decision ledger, so only that source may degrade; the graph must not.
      expect(result.degraded.filter((d) => d.source !== 'decisions')).toEqual([]);
      expect(result.hits.length).toBeGreaterThan(0);
    } finally {
      graph.db.close();
    }
  });
});
