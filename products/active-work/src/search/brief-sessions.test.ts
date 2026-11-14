import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runBrief } from '../commands/context-brief.js';
import { openGraph, type WorkspaceGraph } from '../session-index/graph.js';
import { writeCharter } from '../test-support/visibility.js';
import { scaffold, writeFile } from '../test-support/workspace-index/fixture.js';
import { utf8Bytes } from './brief-block.js';
import { briefSessions, withSessions } from './brief-sessions.js';

/**
 * Sessions that touched the named file, seen through the agent view. `alpha` is agent-visible;
 * `hidden-work` is owner-only. A session tied to neither is withheld, like one tied to `hidden-work`.
 */

const NOW = new Date('2026-10-20T12:00:00.000Z');
const FILE = 'packages/demo/src/app.ts';
const ASSIGNMENT = `Change \`${FILE}\` so the demo renders.`;
const HIDDEN = 'hidden-work';

let dir: string;
let root: string;
let dbPath: string;

const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function touch(graph: WorkspaceGraph, id: string, at: string, fields: { cwd?: string; title?: string }): void {
  graph.db
    .prepare('INSERT INTO session (session_id, cwd, ai_title) VALUES (?, ?, ?)')
    .run(id, fields.cwd ?? null, fields.title ?? null);
  graph.edges.assert({ sourceRef: `session:${id}`, relation: 'touched', targetRef: `file:demo/${FILE}`, tValid: at });
}

function ranTask(graph: WorkspaceGraph, sessionId: string, taskId: string, initiative: string): void {
  graph.db
    .prepare('INSERT OR IGNORE INTO task (task_ref, task_id, initiative) VALUES (?, ?, ?)')
    .run(`task:${taskId}`, taskId, initiative);
  graph.edges.assert({ sourceRef: `session:${sessionId}`, relation: 'ran', targetRef: `task:${taskId}`, tValid: daysAgo(1) });
}

function seedGraph(): void {
  const graph = openGraph(dbPath);
  graph.db.prepare('INSERT INTO file (file_ref, repo, path) VALUES (?, ?, ?)').run(`file:demo/${FILE}`, 'demo', FILE);
  touch(graph, 'alpha-cwd-session', daysAgo(2), { cwd: path.join(root, 'alpha'), title: 'Alpha from its folder' });
  touch(graph, 'alpha-task-session', daysAgo(3), { cwd: '/work/projects/demo', title: 'Alpha by its task' });
  ranTask(graph, 'alpha-task-session', 'AL-1', 'alpha');
  touch(graph, 'hidden-session', daysAgo(1), { cwd: '/work/projects/demo', title: 'Hidden work' });
  ranTask(graph, 'hidden-session', 'HW-1', HIDDEN);
  touch(graph, 'hidden-cwd-session', daysAgo(1), { cwd: path.join(root, HIDDEN), title: 'Hidden folder' });
  touch(graph, 'no-initiative', daysAgo(1), { cwd: '/work/projects/demo', title: 'Nobody owns this' });
  touch(graph, 'alpha-old-session', daysAgo(20), { cwd: path.join(root, 'alpha'), title: 'Alpha long ago' });
  graph.db.close();
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-brief-sessions-'));
  root = path.join(dir, 'active-work');
  dbPath = path.join(dir, 'graph.sqlite3');
  scaffold(root);
  writeCharter(root);
  writeFile(
    root,
    `${HIDDEN}/brief.md`,
    '---\nschema_version: 5\ntitle: hidden\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: HW\n---\n\nBody.\n',
  );
  seedGraph();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('briefSessions', () => {
  it('lists only recent sessions in an initiative the agent view shows, newest first', async () => {
    const result = await briefSessions({ text: ASSIGNMENT, activeRoot: root, now: NOW, dbPath });

    expect(result.degraded).toEqual([]);
    expect(result.lines).toEqual([
      `- alpha-cw ${daysAgo(2).slice(0, 10)} Alpha from its folder`,
      `- alpha-ta ${daysAgo(3).slice(0, 10)} Alpha by its task`,
    ]);
  });

  it('reads nothing when the assignment names no file', async () => {
    const result = await briefSessions({ text: 'No paths here.', activeRoot: root, now: NOW, dbPath });

    expect(result).toEqual({ lines: [], degraded: [] });
  });

  it('a missing graph is a degraded source, not an error', async () => {
    const absent = path.join(dir, 'absent.sqlite3');

    const result = await briefSessions({ text: ASSIGNMENT, activeRoot: root, now: NOW, dbPath: absent });

    expect(result.lines).toEqual([]);
    expect(result.degraded).toContainEqual(expect.objectContaining({ source: 'sessions', reason: 'missing' }));
  });
});

describe('withSessions', () => {
  const empty = { text: '', refs: [], bytes: 0 };

  it('keeps the section inside its byte share however long the titles are', () => {
    const long = `- 12345678 2026-10-19 ${'é'.repeat(60)}`;

    const block = withSessions(empty, { lines: Array.from({ length: 4 }, () => long), degraded: [] }, 2600);

    expect(block.bytes).toBeLessThanOrEqual(500);
    expect(block.bytes).toBe(utf8Bytes(block.text));
    expect(block.text).toContain(long);
  });

  it('never passes the whole budget', () => {
    const workspace = { text: 'x'.repeat(2550), refs: [], bytes: 2550 };

    const block = withSessions(workspace, { lines: ['- 12345678 2026-10-19 A session'], degraded: [] }, 2600);

    expect(block).toEqual(workspace);
  });
});

describe('context.brief with named files', () => {
  it('shows recent sessions for the named files and leaves out withheld ones', async () => {
    const result = await runBrief(
      { for: ASSIGNMENT, initiative: 'alpha' },
      { activeRoot: root, dbPath, now: NOW, hitLog: async () => null, ensureFresh: async () => 'fresh' },
    );

    expect(result.text).toContain('## Recent sessions on the named files');
    expect(result.text).toContain('Alpha from its folder');
    expect(result.text).toContain('Alpha by its task');
    for (const withheld of ['Hidden work', 'Hidden folder', 'Nobody owns this', 'Alpha long ago']) {
      expect(result.text).not.toContain(withheld);
    }
    expect(result.bytes).toBeLessThanOrEqual(2600);
  });
});
