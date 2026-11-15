import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGraph, type WorkspaceGraph } from '../session-index/graph.js';
import { writeFile } from '../test-support/workspace-index/fixture.js';
import { refreshWorkspace } from './refresh.js';

const COUNT = 2000;
const TAG_GROUPS = 500;

let dir: string;
let root: string;
let reads: string[];
let graph: WorkspaceGraph;

const readNote = async (absolutePath: string): Promise<string> => {
  reads.push(absolutePath);
  return fs.readFile(absolutePath, 'utf8');
};

function noteText(i: number, extra = ''): string {
  return [
    '---',
    'kind: process',
    `title: Synthetic note ${i}`,
    'created: 2026-09-02',
    'tags:',
    `  - group-${i % TAG_GROUPS}`,
    '---',
    '',
    `Note ${i} points at AL-${(i % COUNT) + 1}. ${extra}`,
    '',
  ].join('\n');
}

function taskText(i: number, title: string): string {
  return [
    `id: AL-${i}`,
    `title: ${title}`,
    'priority: 1',
    'done_when: the index converges',
    'status: open',
    'created: 2026-09-01',
    'updated: 2026-09-02',
    'done_at: null',
    '',
  ].join('\n');
}

const notePath = (i: number): string => `alpha/sources/notes/2026-09-02-n${i}.md`;
const taskPath = (i: number): string => `alpha/tasks/AL-${i}.yml`;

function seed(): void {
  writeFile(
    root,
    'alpha/brief.md',
    [
      '---',
      'schema_version: 5',
      'title: alpha initiative',
      'updated: 2026-09-01',
      'state: backburner',
      'task_prefix: AL',
      'visibility: agent-visible',
      '---',
      '',
      'Synthetic.',
      '',
    ].join('\n'),
  );
  for (let i = 1; i <= COUNT; i++) {
    writeFile(root, notePath(i), noteText(i));
    writeFile(root, taskPath(i), taskText(i, `Task ${i}`));
  }
}

function edgeDump(g: WorkspaceGraph): unknown[] {
  return g.db
    .prepare(
      "SELECT source_ref, relation, target_ref FROM edge WHERE relation IN ('mentions','shares_tag') ORDER BY source_ref, relation, target_ref",
    )
    .all();
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-ws-latency-'));
  root = path.join(dir, 'active-root');
  seed();
  graph = openGraph(path.join(dir, 'graph.db'));
  reads = [];
  await refreshWorkspace(graph, { activeRoot: root, readNote });
  reads = [];
}, 120_000);

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('refreshWorkspace note body cache', () => {
  it('reads no note body when only a task file changed', async () => {
    writeFile(root, taskPath(7), taskText(7, 'Task seven, retitled'));

    await refreshWorkspace(graph, { activeRoot: root, readNote });

    expect(reads).toEqual([]);
  });

  it('re-reads exactly the one note that was edited', async () => {
    writeFile(root, notePath(12), noteText(12, 'Edited and now longer.'));

    await refreshWorkspace(graph, { activeRoot: root, readNote });

    expect(reads).toEqual([path.join(root, ...notePath(12).split('/'))]);
  });

  it('produces the same edges as a fresh full refresh after an edit', async () => {
    writeFile(root, notePath(12), noteText(12, 'Now mentions AL-1999 as well.'));
    await refreshWorkspace(graph, { activeRoot: root, readNote });

    const cold = openGraph(path.join(dir, 'cold.db'));
    await refreshWorkspace(cold, { activeRoot: root });
    const expected = edgeDump(cold);
    cold.db.close();

    expect(edgeDump(graph)).toEqual(expected);
  });

  it('drops a removed note from the edges without reading anything', async () => {
    rmSync(path.join(root, ...notePath(30).split('/')));

    await refreshWorkspace(graph, { activeRoot: root, readNote });

    const cold = openGraph(path.join(dir, 'cold-removed.db'));
    await refreshWorkspace(cold, { activeRoot: root });
    const expected = edgeDump(cold);
    cold.db.close();

    expect(reads).toEqual([]);
    expect(edgeDump(graph)).toEqual(expected);
  });

  // Wall-clock budgets flake on loaded runners; the read-count tests above are the always-on guard.
  it.skipIf(!process.env.TITAN_BENCH)(
    'finishes a warm one-file refresh in under 800 ms',
    async () => {
      writeFile(root, taskPath(9), taskText(9, 'Task nine, retitled'));

      const started = performance.now();
      await refreshWorkspace(graph, { activeRoot: root, readNote });

      expect(performance.now() - started).toBeLessThan(800);
    },
  );
});
