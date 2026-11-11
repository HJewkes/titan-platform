import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prsNeedingOutcome } from '@titan-design/session-graph';
import type { CommandResult, RunCommand } from '../utils/run-command.js';
import { openGraph, type WorkspaceGraph } from './graph.js';
import { clearPrFailureBackoff, ghPrResolver } from './pr-outcomes.js';

let dir: string;
let graph: WorkspaceGraph;

beforeEach(() => {
  clearPrFailureBackoff();
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-pr-order-'));
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
});

afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const REPO = 'acme/demo';

function addPr(number: number, state: string | null, checkedAt: string | null, commitTimes: string | null): void {
  graph.db
    .prepare(
      'INSERT INTO pr (pr_ref, repo, number, state, outcome_checked_at, commit_times) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(`pr:${REPO}#${number}`, REPO, number, state, checkedAt, commitTimes);
}


function recordingGh(): RunCommand & { asked: number[] } {
  const asked: number[] = [];
  const run = (_bin: string, args: string[]): Promise<CommandResult> => {
    asked.push(Number(args[2]));
    return Promise.resolve({ code: 0, stdout: '{}', stderr: '' });
  };
  return Object.assign(run, { asked });
}

describe('PR outcome batch order', () => {
  it('a backlog over the cap takes never-checked and due open PRs before merged commit-times backfill', async () => {
    addPr(1, 'merged', '2020-01-01T00:00:00Z', null);
    addPr(2, 'merged', '2020-01-02T00:00:00Z', null);
    addPr(3, 'open', '2021-01-01T00:00:00Z', '[]');
    addPr(4, null, null, null);
    const gh = recordingGh();
    const now = () => Date.parse('2026-01-01T00:00:00Z');

    await ghPrResolver({ run: gh, limit: 2, now })(prsNeedingOutcome(graph));

    expect([...gh.asked].sort()).toEqual([3, 4]);
  });

  it('orders within a band by checked-at, then pr_ref', async () => {
    addPr(12, 'open', '2020-01-01T00:00:00Z', '[]');
    addPr(10, 'open', '2021-01-01T00:00:00Z', '[]');
    addPr(11, 'open', '2021-01-01T00:00:00Z', '[]');
    const gh = recordingGh();
    const now = () => Date.parse('2026-01-01T00:00:00Z');

    await ghPrResolver({ run: gh, now })(prsNeedingOutcome(graph));

    expect(gh.asked).toEqual([12, 10, 11]);
  });
});
