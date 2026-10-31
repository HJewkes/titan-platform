import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { searchWorkspace } from '../../src/search/index.js';
import { hasLegacyWorkspaceSpans } from '../../src/search/workspace-spans.js';
import { runRefresh } from '../../src/session-index/refresh.js';
import { openGraph, type WorkspaceGraph } from '../../src/session-index/graph.js';
import {
  pendingBackfillSources,
  workspaceBackfillStatus,
} from '../../src/workspace-index/backfill.js';
import { refreshWorkspace } from '../../src/workspace-index/refresh.js';
import { WORKSPACE_SPAN_SOURCE_BASE } from '../../src/workspace-index/schema.js';
import { WorkspaceWriter } from '../../src/workspace-index/write.js';
import { legacyGraphInto, removeFile, scaffold, writeFile } from './fixture.js';

/**
 * The cutover from `search_span` to `workspace_span` (TP-4680). Each graph here
 * starts as a build before TP-4680 left it, with synthetic transcript spans
 * alongside, and moves through `refreshWorkspace` the way a live store will.
 */

/** Past the pass's 200-file batch, so a failure can land after a commit. */
const EXTRA_NOTES = 250;
const QUERY = 'Prose a search should find';

let dir: string;
let root: string;
let graph: WorkspaceGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-backfill-'));
  root = path.join(dir, 'active-root');
  scaffold(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function addTranscriptSpans(): void {
  for (const i of [0, 1, 2]) {
    graph.spans.index(
      {
        ownerRef: `session:transcript-${i}`,
        field: 'prompt',
        sourceId: i + 1,
        byteOffset: 0,
        byteLength: 9,
      },
      `synthetic transcript prose ${i}`,
    );
  }
}

async function legacyGraph(): Promise<void> {
  graph = await legacyGraphInto(path.join(dir, 'graph.sqlite3'), root);
  addTranscriptSpans();
}

function addNotes(): void {
  for (let i = 0; i < EXTRA_NOTES; i++) {
    writeFile(
      root,
      `alpha/sources/notes/2026-09-10-extra-${i}.md`,
      `---\nkind: process\ntitle: Extra ${i}\ncreated: 2026-09-10\n---\n\nExtra body ${i}.\n`,
    );
  }
}

/** Fail the pass inside its second batch, as a crash would: the first has committed. */
function failDuringBatchTwo(): void {
  const apply = WorkspaceWriter.prototype.apply;
  let calls = 0;
  vi.spyOn(WorkspaceWriter.prototype, 'apply').mockImplementation(function (
    this: WorkspaceWriter,
    ...args
  ) {
    calls++;
    if (calls > 200) throw new Error('synthetic crash');
    apply.apply(this, args);
  });
}

async function interruptedBackfill(): Promise<void> {
  failDuringBatchTwo();
  await expect(refreshWorkspace(graph, { activeRoot: root })).rejects.toThrow('synthetic crash');
  vi.restoreAllMocks();
}

const search = async (): Promise<string> =>
  JSON.stringify((await searchWorkspace(QUERY, { graph, activeRoot: root })).hits);

const spanRows = (table: string, where = '1'): unknown[] =>
  graph.db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY span_id`).all();

const transcriptRows = (): unknown[] =>
  spanRows('search_span', `source_id < ${WORKSPACE_SPAN_SOURCE_BASE}`);

const locators = (): unknown[] =>
  graph.db
    .prepare(
      `SELECT owner_ref, field, source_id, byte_offset, byte_length FROM workspace_span
        ORDER BY owner_ref, field, source_id, byte_offset`,
    )
    .all();

const count = (table: string): number =>
  (graph.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('workspace span backfill', () => {
  it('flips a legacy graph with one clean pass, leaving what a fresh index holds', async () => {
    await legacyGraph();

    const summary = await refreshWorkspace(graph, { activeRoot: root });
    const backfilled = locators();
    const hits = await searchWorkspace(QUERY, { graph, activeRoot: root });
    graph.db.close();
    graph = openGraph(path.join(dir, 'fresh.sqlite3'));
    await refreshWorkspace(graph, { activeRoot: root });

    expect(summary.legacySpansRetired).toBeGreaterThan(0);
    expect(summary.indexed).toBe(summary.files);
    expect(backfilled).toEqual(locators());
    expect(hits.hits[0]?.ref).toBe('source:beta/design.md');
  });

  it('keeps the flip back until a pass finishes and leaves search byte-identical', async () => {
    addNotes();
    await legacyGraph();
    const before = await search();
    const legacyRows = spanRows('search_span');

    await interruptedBackfill();

    expect(hasLegacyWorkspaceSpans(graph)).toBe(true);
    expect(count('workspace_span')).toBeGreaterThan(0);
    expect(spanRows('search_span')).toEqual(legacyRows);
    expect(await search()).toBe(before);
  });

  it('resumes after the last committed batch and then flips', async () => {
    addNotes();
    await legacyGraph();
    await interruptedBackfill();
    const remaining = pendingBackfillSources(graph.db).size;

    const summary = await refreshWorkspace(graph, { activeRoot: root });

    expect(remaining).toBeGreaterThan(0);
    expect(summary.indexed).toBe(remaining);
    expect(summary.unchanged).toBe(summary.files - remaining);
    expect(summary.unchanged).toBeGreaterThan(0);
    expect(hasLegacyWorkspaceSpans(graph)).toBe(false);
    expect(await search()).toContain('source:beta/design.md');
  });

  it('is idempotent once flipped', async () => {
    await legacyGraph();
    await refreshWorkspace(graph, { activeRoot: root });
    const flipped = locators();

    const again = await refreshWorkspace(graph, { activeRoot: root });

    expect(again).toMatchObject({ indexed: 0, legacySpansRetired: 0 });
    expect(locators()).toEqual(flipped);
  });

  it('leaves transcript spans untouched across the backfill', async () => {
    await legacyGraph();
    const before = transcriptRows();

    await refreshWorkspace(graph, { activeRoot: root });

    expect(before).toHaveLength(3);
    expect(transcriptRows()).toEqual(before);
  });

  it('hides a purged file from readers still on the legacy table', async () => {
    await legacyGraph();
    const before = await search();
    const { sourceId } = graph.workspaceFiles.ensure('beta/sources/design.md');

    new WorkspaceWriter(graph).purge('beta/sources/design.md', sourceId);

    expect(hasLegacyWorkspaceSpans(graph)).toBe(true);
    expect(before).toContain('source:beta/design.md');
    expect(await search()).not.toContain('source:beta/design.md');
  });

  it('flips past a malformed file, as any pass would drop it', async () => {
    await legacyGraph();
    writeFile(root, 'beta/tasks/BE-7.yml', 'id: not-a-task-id\nthis: is not a task\n');

    const summary = await refreshWorkspace(graph, { activeRoot: root });

    expect(summary.malformed.map((entry) => entry.path)).toEqual(['beta/tasks/BE-7.yml']);
    expect(hasLegacyWorkspaceSpans(graph)).toBe(false);
  });
});

describe('workspace span reset', () => {
  it('rebuilds a damaged table from the files, through the refresh option', async () => {
    await legacyGraph();
    await refreshWorkspace(graph, { activeRoot: root });
    const healthy = locators();
    graph.db.exec("DELETE FROM workspace_span WHERE owner_ref LIKE 'note:%'");

    await runRefresh({
      graph,
      transcripts: [],
      activeRoot: root,
      taskRoot: root,
      skipPrOutcomes: true,
      resetWorkspaceSpans: true,
    });

    expect(locators()).toEqual(healthy);
    expect(count('workspace_fts')).toBe(healthy.length);
  });

  it('leaves transcript spans and a pending backfill alone', async () => {
    await legacyGraph();
    const before = transcriptRows();

    await runRefresh({
      graph,
      transcripts: [],
      activeRoot: root,
      taskRoot: root,
      skipPrOutcomes: true,
      resetWorkspaceSpans: true,
    });

    expect(transcriptRows()).toEqual(before);
    expect(hasLegacyWorkspaceSpans(graph)).toBe(false);
  });
});

describe('workspaceBackfillStatus', () => {
  it('reports pending, in progress and complete from the data alone', async () => {
    addNotes();
    await legacyGraph();
    expect(workspaceBackfillStatus(graph.db)).toMatchObject({ state: 'pending', workspaceSpans: 0 });

    await interruptedBackfill();
    const interrupted = workspaceBackfillStatus(graph.db);
    await refreshWorkspace(graph, { activeRoot: root });

    expect(interrupted.state).toBe('in_progress');
    expect(interrupted.pendingFiles).toBeGreaterThan(0);
    expect(workspaceBackfillStatus(graph.db)).toEqual({
      state: 'complete',
      legacySpans: 0,
      workspaceSpans: count('workspace_span'),
      pendingFiles: 0,
    });
  });

  it('calls a graph from before schema 1003 pending rather than failing', async () => {
    await legacyGraph();
    const legacySpans = workspaceBackfillStatus(graph.db).legacySpans;
    graph.db.exec('DROP TABLE workspace_span');

    expect(workspaceBackfillStatus(graph.db)).toEqual({
      state: 'pending',
      legacySpans,
      workspaceSpans: 0,
      pendingFiles: 0,
    });
  });
});

describe('workspace_fts under edits', () => {
  it('holds one row per live span after a task is edited 50 times', async () => {
    graph = openGraph(path.join(dir, 'graph.sqlite3'));
    for (let edit = 0; edit < 50; edit++) {
      writeFile(
        root,
        'beta/tasks/BE-7.yml',
        [
          'id: BE-7',
          `title: Edit number ${edit}`,
          'priority: 1',
          'done_when: it holds',
          'notes: edited',
          'status: open',
          'created: 2026-09-01',
          'updated: 2026-09-02',
          'done_at: null',
          '',
        ].join('\n'),
      );
      await refreshWorkspace(graph, { activeRoot: root });
    }

    expect(count('workspace_fts')).toBe(count('workspace_span'));
  });
});
