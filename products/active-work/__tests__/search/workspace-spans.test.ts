import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { graphNoteRelevance } from '../../src/bootstrap/rank-notes.js';
import type { WorkspaceGraph } from '../../src/session-index/graph.js';
import { searchWorkspace } from '../../src/search/index.js';
import {
  hasLegacyWorkspaceSpans,
  workspaceSpanReader,
  workspaceSpanTable,
} from '../../src/search/workspace-spans.js';
import { WORKSPACE_SPAN_SOURCE_BASE } from '../../src/workspace-index/schema.js';
import { demoteToLegacy, refreshInto, scaffold } from '../workspace-index/fixture.js';

/**
 * The selector (TP-4680): a graph holding legacy workspace spans is read through
 * `search_span`, and one holding none through `workspace_span`.
 */

let dir: string;
let root: string;
let dbPath: string;
let graph: WorkspaceGraph;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-workspace-spans-'));
  root = path.join(dir, 'active');
  dbPath = path.join(dir, 'graph.sqlite3');
  scaffold(root);
  graph = await refreshInto(dbPath, root);
});

afterEach(() => {
  vi.restoreAllMocks();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const hitPaths = async () =>
  (await searchWorkspace('Prose a search should find', { graph, activeRoot: root })).hits.map(
    (hit) => [hit.ref, hit.path, hit.excerpt],
  );

describe('workspaceSpanTable', () => {
  it('stays on the shared table while legacy workspace spans remain', () => {
    demoteToLegacy(graph, root);

    expect(hasLegacyWorkspaceSpans(graph)).toBe(true);
    expect(workspaceSpanTable(graph)).toBe(graph.spans);
  });

  it('reads the workspace table once no legacy span remains', () => {
    expect(hasLegacyWorkspaceSpans(graph)).toBe(false);
    expect(workspaceSpanTable(graph)).toBe(graph.workspaceSpans);
  });

  it('probes legacy spans through the source index rather than a scan', () => {
    const plan = graph.db
      .prepare('EXPLAIN QUERY PLAN SELECT 1 AS hit FROM search_span WHERE source_id >= ? LIMIT 1')
      .all(WORKSPACE_SPAN_SOURCE_BASE) as { detail: string }[];

    expect(plan.map((step) => step.detail).join('\n')).toContain('idx_search_span_source');
  });
});

describe('workspaceSpanReader', () => {
  it('keeps a query on its snapshot when the flip commits between the choice and the search', () => {
    demoteToLegacy(graph, root);
    const before = graph.spans.search('"Prose a search should find"');
    const other = new Database(dbPath);
    const search = graph.spans.search.bind(graph.spans);
    vi.spyOn(graph.spans, 'search').mockImplementation((...args) => {
      other.prepare('DELETE FROM search_span WHERE source_id >= ?').run(WORKSPACE_SPAN_SOURCE_BASE);
      return search(...args);
    });

    const hits = workspaceSpanReader(graph).search('"Prose a search should find"');
    other.close();

    expect(before.length).toBeGreaterThan(0);
    expect(hits).toEqual(before);
  });
});

describe('workspace readers across a cutover', () => {
  it('search finds the same workspace hits in either table', async () => {
    const cutOver = await hitPaths();
    demoteToLegacy(graph, root);

    expect(cutOver.length).toBeGreaterThan(0);
    expect(await hitPaths()).toEqual(cutOver);
  });

  it('search hits only the current table', async () => {
    demoteToLegacy(graph, root);
    graph.workspaceSpans.index(
      { ownerRef: 'note:alpha/decoy.md', field: 'body', sourceId: 1, byteOffset: 0, byteLength: 6 },
      'decoywordonly',
    );

    expect((await searchWorkspace('decoywordonly', { graph, activeRoot: root })).hits).toEqual([]);
  });

  it('note relevance finds the same notes in either table', () => {
    const terms = ['lesson'];
    const cutOver = graphNoteRelevance(dbPath)(terms).map((hit) => hit.ref);
    demoteToLegacy(graph, root);

    expect(cutOver.length).toBeGreaterThan(0);
    expect(graphNoteRelevance(dbPath)(terms).map((hit) => hit.ref)).toEqual(cutOver);
  });
});
