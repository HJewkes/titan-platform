import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { graphNoteRelevance } from '../../src/bootstrap/rank-notes.js';
import type { WorkspaceGraph } from '../../src/session-index/graph.js';
import { searchWorkspace } from '../../src/search/index.js';
import {
  hasLegacyWorkspaceSpans,
  workspaceSpanTable,
} from '../../src/search/workspace-spans.js';
import { WORKSPACE_SPAN_SOURCE_BASE } from '../../src/workspace-index/schema.js';
import { refreshInto, scaffold } from '../workspace-index/fixture.js';

/**
 * The selector that S3's cutover will flip (TP-4680). Until it is told to cut
 * over it answers the shared table; told to, it reads the workspace table only
 * once no workspace span is left in the shared one.
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
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface LegacySpan {
  owner_ref: string;
  field: string;
  source_id: number;
  byte_offset: number;
  byte_length: number;
  source_key: string;
}

/** What S3's backfill and flip will do, done by hand: re-index each workspace span, then drop the legacy rows. */
function moveWorkspaceSpans(): void {
  const rows = graph.db
    .prepare<[number, number], LegacySpan>(
      `SELECT s.owner_ref, s.field, s.source_id, s.byte_offset, s.byte_length, w.source_key
       FROM search_span s JOIN workspace_file w ON s.source_id = w.source_id + ?
       WHERE s.source_id >= ?`,
    )
    .all(WORKSPACE_SPAN_SOURCE_BASE, WORKSPACE_SPAN_SOURCE_BASE);
  for (const row of rows) {
    const bytes = readFileSync(path.join(root, row.source_key));
    const text = bytes.subarray(row.byte_offset, row.byte_offset + row.byte_length).toString('utf8');
    graph.workspaceSpans.index(
      {
        ownerRef: row.owner_ref,
        field: row.field,
        sourceId: row.source_id,
        byteOffset: row.byte_offset,
        byteLength: row.byte_length,
      },
      text,
    );
  }
  graph.db.prepare('DELETE FROM search_span WHERE source_id >= ?').run(WORKSPACE_SPAN_SOURCE_BASE);
}

const hitPaths = async (options = {}) =>
  (await searchWorkspace('Prose a search should find', { graph, activeRoot: root, ...options }))
    .hits.map((hit) => [hit.ref, hit.path, hit.excerpt]);

describe('workspaceSpanTable', () => {
  it('answers the shared table by default even when the graph is cut over', () => {
    moveWorkspaceSpans();

    expect(workspaceSpanTable(graph)).toBe(graph.spans);
  });

  it('stays on the shared table while legacy workspace spans remain, even when told to cut over', () => {
    expect(hasLegacyWorkspaceSpans(graph)).toBe(true);

    expect(workspaceSpanTable(graph, { cutover: true })).toBe(graph.spans);
  });

  it('reads the workspace table once told to cut over and no legacy span remains', () => {
    moveWorkspaceSpans();

    expect(hasLegacyWorkspaceSpans(graph)).toBe(false);
    expect(workspaceSpanTable(graph, { cutover: true })).toBe(graph.workspaceSpans);
  });

  it('probes legacy spans through the source index rather than a scan', () => {
    const plan = graph.db
      .prepare('EXPLAIN QUERY PLAN SELECT 1 AS hit FROM search_span WHERE source_id >= ? LIMIT 1')
      .all(WORKSPACE_SPAN_SOURCE_BASE) as { detail: string }[];

    expect(plan.map((step) => step.detail).join('\n')).toContain('idx_search_span_source');
  });
});

describe('workspace readers after a hand-made cutover', () => {
  it('search finds the same workspace hits in the new table only when told to', async () => {
    const before = await hitPaths();
    moveWorkspaceSpans();

    expect(before.length).toBeGreaterThan(0);
    expect(await hitPaths()).toEqual([]);
    expect(await hitPaths({ workspaceSpans: { cutover: true } })).toEqual(before);
  });

  it('note relevance reads the new table only when told to', () => {
    const terms = ['lesson'];
    const before = graphNoteRelevance(dbPath)(terms).map((hit) => hit.ref);
    moveWorkspaceSpans();

    expect(before.length).toBeGreaterThan(0);
    expect(graphNoteRelevance(dbPath)(terms)).toEqual([]);
    expect(graphNoteRelevance(dbPath, { cutover: true })(terms).map((hit) => hit.ref)).toEqual(
      before,
    );
  });
});
