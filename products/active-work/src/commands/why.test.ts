import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRepoCache } from '@titan-design/session-read';
import type { CommandContext } from '../registry/types.js';
import { openGraph, type WorkspaceGraph } from '../session-index/graph.js';
import { writeCharter } from '../test-support/visibility.js';
import { scaffold, writeFile } from '../test-support/workspace-index/fixture.js';
import whyCommand from './why.js';

/**
 * A synthetic repo where line 12 was last changed by "Fix x (#42)" and line 3 later by #43, and a
 * graph that links PR 42 to task AL-1 (agent-visible `alpha`) and to a session in owner-only work.
 */

const HIDDEN = 'hidden-work';
const AT = '2026-10-20T12:00:00.000Z';

let dir: string;
let root: string;
let repo: string;

function git(...args: string[]): void {
  const run = spawnSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(run.stderr);
}

function commit(lines: string[], message: string): void {
  writeFileSync(path.join(repo, 'a.ts'), `${lines.join('\n')}\n`);
  git('add', 'a.ts');
  git('commit', '-q', '-m', message);
}

function seedRepo(): void {
  mkdirSync(repo);
  git('init', '-q');
  const lines = Array.from({ length: 20 }, (_, i) => `const line${i + 1} = ${i + 1};`);
  commit(lines, 'Add a.ts (#40)');
  lines[11] = 'const line12 = "fixed";';
  commit(lines, 'Fix x (#42)\n\nRefs: AL-1, #42');
  lines[2] = 'const line3 = "later";';
  commit(lines, 'Tweak another line (#43)');
  lines[14] = 'const line15 = "traced";';
  commit(lines, 'Trace a line (#44)\n\nAgent-Session: trailer-session');
  lines[17] = 'const line18 = "mixed";';
  commit(lines, 'Mixed work (#45)');
  lines[18] = 'const line19 = "unknown";';
  commit(lines, 'Unknown work (#46)');
}

function seedGraph(): void {
  const graph: WorkspaceGraph = openGraph(path.join(root, '.miner', 'graph.sqlite3'));
  const session = (id: string, cwd: string) => graph.db.prepare('INSERT INTO session (session_id, cwd, ai_title) VALUES (?, ?, ?)').run(id, cwd, `title ${id}`);
  const ran = (id: string, taskId: string, initiative: string) => {
    graph.db.prepare('INSERT OR IGNORE INTO task (task_ref, task_id, initiative) VALUES (?, ?, ?)').run(`task:${taskId}`, taskId, initiative);
    graph.edges.assert({ sourceRef: `session:${id}`, relation: 'ran', targetRef: `task:${taskId}`, tValid: AT });
  };
  const linked = (id: string, num: number) => {
    graph.db.prepare('INSERT OR IGNORE INTO pr (pr_ref, number, repo) VALUES (?, ?, ?)').run(`pr:acme/demo#${num}`, num, 'acme/demo');
    graph.edges.assert({ sourceRef: `session:${id}`, relation: 'linked', targetRef: `pr:acme/demo#${num}`, tValid: AT });
  };
  session('impl-session', '/work/projects/demo');
  linked('impl-session', 42);
  ran('impl-session', 'AL-1', 'alpha');
  session('peer-session', '/work/projects/demo');
  ran('peer-session', 'AL-1', 'alpha');
  session('hidden-session', '/work/projects/demo');
  linked('hidden-session', 42);
  ran('hidden-session', 'HW-1', HIDDEN);
  session('later-session', '/work/projects/demo');
  linked('later-session', 43);
  ran('later-session', 'AL-1', 'alpha');
  session('trailer-session', path.join(root, 'alpha'));
  session('mixed-session', path.join(root, 'alpha'));
  linked('mixed-session', 45);
  ran('mixed-session', 'AL-2', 'alpha');
  ran('mixed-session', 'AL-3', 'alpha');
  ran('mixed-session', 'HW-2', HIDDEN);
  session('unknown-session', path.join(root, 'alpha'));
  linked('unknown-session', 46);
  ran('unknown-session', 'AL-4', 'alpha');
  ran('unknown-session', 'GW-1', 'gone-work');
  graph.db.close();
}

function ctx(caller: 'owner' | 'agent'): CommandContext {
  return { activeRoot: root, caller, cwd: repo, warnings: [], format: 'json' };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-why-'));
  root = path.join(dir, 'active-work');
  repo = path.join(dir, 'demo');
  vi.stubEnv('ACTIVE_ROOT', root);
  clearRepoCache();
  scaffold(root);
  writeCharter(root);
  writeFile(root, `${HIDDEN}/brief.md`, '---\nschema_version: 5\ntitle: hidden\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: HW\n---\n\nBody.\n');
  seedRepo();
  seedGraph();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('why', () => {
  it('maps the line to the commit that last changed it, not the latest commit on the file', async () => {
    const { commits } = await whyCommand.run({ target: 'a.ts:12' }, ctx('agent'));

    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ subject: 'Fix x (#42)', lines: ['12'], prNumber: 42, prRefs: ['pr:acme/demo#42'] });
    expect(commits.at(0)?.tasks).toEqual([{ taskId: 'AL-1', initiative: 'alpha', step: 'refs' }]);
    expect(commits.at(0)?.sessions.map((s) => [s.sessionId, s.step])).toEqual([
      ['impl-session', 'pr-subject'],
      ['later-session', 'pr-task'],
      ['peer-session', 'pr-task'],
    ]);
  });

  it('keeps a session in an owner-only initiative from an agent and counts it hidden', async () => {
    const { commits } = await whyCommand.run({ target: 'a.ts:12' }, ctx('agent'));

    expect(commits.at(0)?.sessions.map((s) => s.sessionId)).not.toContain('hidden-session');
    expect(commits.at(0)?.tasks.map((t) => t.taskId)).not.toContain('HW-1');
    expect(commits.at(0)?.hidden).toBe(2);
  });

  it('keeps a session linked to a visible and an owner-only task from an agent', async () => {
    const { commits } = await whyCommand.run({ target: 'a.ts:18' }, ctx('agent'));

    expect(commits.at(0)?.sessions).toEqual([]);
    expect(commits.at(0)?.hidden).toBe(2);
  });

  it('keeps a session linked to a task of unknown visibility from an agent', async () => {
    const { commits } = await whyCommand.run({ target: 'a.ts:19' }, ctx('agent'));

    expect(commits.at(0)?.sessions).toEqual([]);
    expect(commits.at(0)?.hidden).toBe(2);
  });

  it('serves the owner the owner-only session too', async () => {
    const { commits } = await whyCommand.run({ target: 'a.ts:12' }, ctx('owner'));

    expect(commits.at(0)?.sessions).toContainEqual({ sessionId: 'hidden-session', step: 'pr-subject', title: 'title hidden-session', initiative: HIDDEN });
    expect(commits.at(0)?.hidden).toBe(0);
  });

  it('reads an Agent-Session trailer before the PR', async () => {
    const { commits } = await whyCommand.run({ target: 'a.ts:15' }, ctx('agent'));

    expect(commits[0]).toMatchObject({ subject: 'Trace a line (#44)', prNumber: 44 });
    expect(commits.at(0)?.sessions).toEqual([{ sessionId: 'trailer-session', step: 'trailer', title: 'title trailer-session', initiative: 'alpha' }]);
  });

  it('splits a range across the commits that last changed each line', async () => {
    const { commits } = await whyCommand.run({ target: 'a.ts:11-13' }, ctx('agent'));

    expect(commits.map((c) => [c.subject, c.lines])).toEqual([
      ['Add a.ts (#40)', ['11', '13']],
      ['Fix x (#42)', ['12']],
    ]);
  });

  it('refuses a target with no line range', async () => {
    await expect(whyCommand.run({ target: 'a.ts' }, ctx('agent'))).rejects.toThrow(/expected <path>:<line>/);
  });
});
