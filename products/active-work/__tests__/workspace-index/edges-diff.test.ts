import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraph, type WorkspaceGraph } from '../../src/session-index/graph.js';
import { refreshWorkspace } from '../../src/workspace-index/refresh.js';
import { refreshInto, scaffold, writeFile } from './fixture.js';

/**
 * The daemon refreshes every sixty seconds, so a pass over an unchanged
 * workspace must leave the edge table byte-for-byte alone: no row rewritten,
 * no `edge_id` consumed (TP-886).
 */

let dir: string;
let root: string;
let graph: WorkspaceGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-ws-edges-'));
  root = path.join(dir, 'active-root');
  scaffold(root);
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
});

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Row {
  edge_id: number;
  source_ref: string;
  relation: string;
  target_ref: string;
}

function edgeRows(db: WorkspaceGraph['db']): Row[] {
  return db
    .prepare('SELECT edge_id, source_ref, relation, target_ref FROM edge ORDER BY edge_id')
    .all() as Row[];
}

function maxEdgeId(): number {
  const row = graph.db.prepare('SELECT max(edge_id) AS id FROM edge').get() as { id: number };
  return row.id;
}

const triple = (row: Row): string => `${row.source_ref} ${row.relation} ${row.target_ref}`;

function alphaNote(body: string): string {
  return [
    '---',
    'kind: process',
    'title: The alpha lesson',
    'created: 2026-09-02',
    'tags:',
    '  - worktree',
    '  - process',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

describe('workspace edges by diff', () => {
  it('leaves every edge row and the max edge id alone on passes over an unchanged workspace', async () => {
    await refreshWorkspace(graph, { activeRoot: root });
    // As on the live graph, other writers' rows sit above the derived ones; without one, SQLite would
    // hand a delete-all-and-reinsert pass the same rowids back.
    graph.edges.assert({ sourceRef: 'session:s1', relation: 'touched', targetRef: 'task:AL-1' });
    const before = edgeRows(graph.db);
    const maxBefore = maxEdgeId();

    await refreshWorkspace(graph, { activeRoot: root });
    await refreshWorkspace(graph, { activeRoot: root, full: true });

    expect(before.length).toBeGreaterThan(0);
    expect(maxEdgeId()).toBe(maxBefore);
    expect(edgeRows(graph.db)).toEqual(before);
  });

  it('turns one swapped mention into exactly one insert and one delete, matching a full rebuild', async () => {
    await refreshWorkspace(graph, { activeRoot: root });
    const before = edgeRows(graph.db);
    const maxBefore = maxEdgeId();

    writeFile(
      root,
      'alpha/sources/notes/2026-09-02-alpha-lesson.md',
      alphaNote('This one now references AL-1 at home instead.'),
    );
    await refreshWorkspace(graph, { activeRoot: root });
    const after = edgeRows(graph.db);

    const afterIds = new Set(after.map((row) => row.edge_id));
    const deleted = before.filter((row) => !afterIds.has(row.edge_id));
    const inserted = after.filter((row) => row.edge_id > maxBefore);
    expect(deleted.map(triple)).toEqual([expect.stringMatching(/ mentions task:BE-7$/)]);
    expect(inserted.map(triple)).toEqual([expect.stringMatching(/ mentions task:AL-1$/)]);

    const rebuilt = await refreshInto(path.join(dir, 'rebuilt.sqlite3'), root, true);
    try {
      expect(after.map(triple).sort()).toEqual(edgeRows(rebuilt.db).map(triple).sort());
    } finally {
      rebuilt.db.close();
    }
  });

  it('treats a note whose stored tags are not a string list as untagged, keeping its mentions', async () => {
    await refreshWorkspace(graph, { activeRoot: root });
    const alphaEdges = (relation: string): Row[] =>
      edgeRows(graph.db).filter(
        (row) => row.source_ref.includes('alpha-lesson') && row.relation === relation,
      );
    const mentions = alphaEdges('mentions').map(triple);
    graph.db
      .prepare("UPDATE note SET tags = '{truncated' WHERE path LIKE '%alpha-lesson%'")
      .run();

    await refreshWorkspace(graph, { activeRoot: root });

    expect(mentions.length).toBeGreaterThan(0);
    expect(alphaEdges('mentions').map(triple)).toEqual(mentions);
    expect(alphaEdges('shares_tag')).toEqual([]);
  });

  it("leaves another writer's edge untouched across passes", async () => {
    graph.edges.assert({ sourceRef: 'session:s1', relation: 'touched', targetRef: 'task:AL-1' });
    const foreign = edgeRows(graph.db).filter((row) => row.relation === 'touched');

    await refreshWorkspace(graph, { activeRoot: root });
    writeFile(
      root,
      'alpha/sources/notes/2026-09-02-alpha-lesson.md',
      alphaNote('This one now references AL-1 at home instead.'),
    );
    await refreshWorkspace(graph, { activeRoot: root });

    expect(edgeRows(graph.db).filter((row) => row.relation === 'touched')).toEqual(foreign);
  });
});
