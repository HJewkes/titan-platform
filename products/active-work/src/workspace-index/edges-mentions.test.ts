import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraph, type WorkspaceGraph } from '../session-index/graph.js';
import { refreshWorkspace } from './refresh.js';
import { refreshInto, writeFile } from '../test-support/workspace-index/fixture.js';

let dir: string;
let root: string;
let graph: WorkspaceGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-ws-mentions-'));
  root = path.join(dir, 'active-root');
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
});

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const OVERSIZED_BYTES = 256 * 1024 + 1;

function brief(): string {
  return [
    '---',
    'schema_version: 5',
    'title: gamma initiative',
    'updated: 2026-09-01',
    'state: backburner',
    'task_prefix: TP',
    'visibility: agent-visible',
    '---',
    '',
    'Synthetic initiative.',
    '',
  ].join('\n');
}

function task(id: string, title: string, notes: string): string {
  return [
    `id: ${id}`,
    `title: ${title}`,
    'priority: 1',
    'done_when: the index converges',
    `notes: ${notes}`,
    'status: open',
    'created: 2026-09-01',
    'updated: 2026-09-02',
    'done_at: null',
    '',
  ].join('\n');
}

function seed(): void {
  writeFile(root, 'gamma/brief.md', brief());
  writeFile(root, 'gamma/tasks/TP-12.yml', task('TP-12', 'Twelfth', 'nothing'));
  writeFile(root, 'gamma/tasks/TP-7.yml', task('TP-7', 'Seventh', 'nothing'));
  writeFile(root, 'gamma/tasks/TP-9.yml', task('TP-9', 'Ninth TP-9', "'Related: TP-7 and TP-9'"));
  writeFile(root, 'gamma/sources/plan.md', '# Plan\n\nThis plan covers TP-12.\n');
}

const rowSchema = z.object({
  source_ref: z.string(),
  relation: z.string(),
  target_ref: z.string(),
});

function mentions(db: WorkspaceGraph['db']): string[] {
  return z
    .array(rowSchema)
    .parse(
      db
        .prepare(
          "SELECT source_ref, relation, target_ref FROM edge WHERE relation = 'mentions' ORDER BY 1, 3",
        )
        .all(),
    )
    .map((row) => `${row.source_ref} -> ${row.target_ref}`);
}

describe('mentions from sources and tasks', () => {
  it('links a source plan to the task it names', async () => {
    seed();
    await refreshWorkspace(graph, { activeRoot: root });

    expect(mentions(graph.db)).toContain('source:gamma/plan.md -> task:TP-12');
  });

  it('links a task to the task its notes name, and never to itself', async () => {
    seed();
    await refreshWorkspace(graph, { activeRoot: root });

    const fromNinth = mentions(graph.db).filter((edge) => edge.startsWith('task:TP-9 '));
    expect(fromNinth).toEqual(['task:TP-9 -> task:TP-7']);
  });

  it('gives a full rebuild and an incremental sequence the same edge set', async () => {
    seed();
    await refreshWorkspace(graph, { activeRoot: root });
    writeFile(root, 'gamma/sources/plan.md', '# Plan\n\nNow covers TP-7 as well.\n');
    await refreshWorkspace(graph, { activeRoot: root });

    const rebuilt = await refreshInto(path.join(dir, 'rebuilt.sqlite3'), root, true);
    try {
      expect(mentions(graph.db)).toEqual(mentions(rebuilt.db));
      expect(mentions(graph.db)).toContain('source:gamma/plan.md -> task:TP-7');
    } finally {
      rebuilt.db.close();
    }
  });

  it('adds no edges for an oversized source and counts it in the summary', async () => {
    seed();
    writeFile(root, 'gamma/sources/big.md', `# Big\n\nTP-12\n${'x'.repeat(OVERSIZED_BYTES)}\n`);

    const summary = await refreshWorkspace(graph, { activeRoot: root });

    expect(mentions(graph.db).filter((edge) => edge.startsWith('source:gamma/big.md'))).toEqual([]);
    expect(summary.oversizedSources).toBe(1);
  });
});
