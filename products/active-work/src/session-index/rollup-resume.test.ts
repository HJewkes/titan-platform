import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { indexTranscript, type refreshCorpus } from '@titan-design/session-graph';
import { openGraph, type WorkspaceGraph } from './graph.js';
import { selectOne } from '../test-support/session-index/query.js';
import { runRefresh, type RefreshOptions } from './refresh.js';
import { FIXTURE_LINES, renderTranscript } from '../test-support/session-index/fixture.js';

// Index the first transcript, advancing its watermark, then die before the rollup.
const cut: typeof refreshCorpus = async (graph, transcripts) => {
  const first = transcripts.at(0);
  if (first) await indexTranscript(graph, first);
  throw new Error('pass killed between index and rollup');
};

let dir: string;
let root: string;
let graph: WorkspaceGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-rollup-resume-'));
  root = path.join(dir, 'projects');
  mkdirSync(path.join(root, 'demo'), { recursive: true });
  writeFileSync(path.join(root, 'demo', 'a.jsonl'), renderTranscript(FIXTURE_LINES), 'utf8');
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
  vi.stubEnv('AGENT_CHAT_HOME', path.join(dir, 'agent-chat'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const unfinishedTurns = (): number =>
  selectOne<{ n: number }>(graph.db, 'SELECT COUNT(*) AS n FROM turn WHERE ended_at IS NULL').n;

const pass = (steps: RefreshOptions['steps'] = {}): ReturnType<typeof runRefresh> =>
  runRefresh({ graph, root, skipPrOutcomes: true, skipWorkspace: true, taskRoot: dir, steps });

describe('a full pass cut between index and rollup', () => {
  it('leaves no turn without ended_at after the next pass', async () => {
    await expect(pass({ refreshCorpus: cut })).rejects.toThrow('pass killed');
    expect(unfinishedTurns()).toBeGreaterThan(0);

    const next = await pass();

    expect(next.unchanged).toBe(1);
    expect(next.turnsRolledUp).toBeGreaterThan(0);
    expect(unfinishedTurns()).toBe(0);
  });

  it('rolls up nothing extra once every turn has ended_at', async () => {
    await pass();

    const next = await pass();

    expect(next.unchanged).toBe(1);
    expect(next.turnsRolledUp).toBe(0);
  });
});
