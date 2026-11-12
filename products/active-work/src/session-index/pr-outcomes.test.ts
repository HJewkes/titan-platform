/**
 * TP-275: PR outcomes filled from the forge through `gh`, behind
 * `@titan-design/session-graph`'s `PrResolver` seam. `gh` is mocked at the
 * process boundary, so no test here ever runs the real binary.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enrichPrs, prsNeedingOutcome } from '@titan-design/session-graph';
import { lookup } from '../test-support/test-helpers.js';
import type { CommandResult, RunCommand } from '../utils/run-command.js';
import { openGraph, type WorkspaceGraph } from './graph.js';
import { selectMaybe } from '../test-support/session-index/query.js';
import { clearPrFailureBackoff, ghPrResolver } from './pr-outcomes.js';
import { runRefresh } from './refresh.js';

let dir: string;
let graph: WorkspaceGraph;

beforeEach(() => {
  clearPrFailureBackoff();
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-pr-outcomes-'));
  graph = openGraph(path.join(dir, 'graph.sqlite3'));
  vi.stubEnv('AGENT_CHAT_HOME', path.join(dir, 'agent-chat'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

type GhAnswer = Record<string, unknown> | Error | CommandResult;

const isCommandResult = (answer: GhAnswer | undefined): answer is CommandResult =>
  answer !== undefined && !(answer instanceof Error) && 'code' in answer;

/** A `gh` stand-in keyed by `<repo>#<number>`; records every PR it was asked about. */
function fakeGh(answers: Record<string, GhAnswer>): RunCommand & { asked: string[] } {
  const asked: string[] = [];
  const run = (_bin: string, args: string[]): Promise<CommandResult> => {
    const key = `${args[args.indexOf('--repo') + 1] ?? ''}#${args[2] ?? ''}`;
    asked.push(key);
    const answer = lookup(answers, key);
    if (answer instanceof Error) return Promise.reject(answer);
    if (isCommandResult(answer)) return Promise.resolve(answer);
    return Promise.resolve({ code: 0, stdout: JSON.stringify(answer ?? {}), stderr: '' });
  };
  return Object.assign(run, { asked });
}

function addPr(
  number: number,
  fields: {
    state?: string | null;
    checkedAt?: string | null;
    repo?: string;
    commitTimes?: string | null;
  } = {},
): void {
  const repo = fields.repo ?? 'acme/demo';
  graph.db
    .prepare(
      'INSERT INTO pr (pr_ref, repo, number, state, outcome_checked_at, commit_times) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      `pr:${repo}#${number}`,
      repo,
      number,
      fields.state ?? null,
      fields.checkedAt ?? null,
      // A checked PR normally has its commit times stored; tests of the gap pass null.
      fields.commitTimes === undefined ? (fields.checkedAt ? '[]' : null) : fields.commitTimes,
    );
}

const rowFor = (number: number): Record<string, unknown> | undefined =>
  selectMaybe<Record<string, unknown>>(
    graph.db,
    'SELECT state, merged_at, closed_at, review_rounds, outcome_checked_at FROM pr WHERE number = ?',
    number,
  );

const pr = (fields: Record<string, unknown>): Record<string, unknown> => ({
  state: 'OPEN',
  mergedAt: null,
  closedAt: null,
  reviews: [],
  commits: [],
  ...fields,
});

describe('the gh PR resolver', () => {
  it('fills merged and closed state', async () => {
    addPr(1);
    addPr(2);
    const gh = fakeGh({
      'acme/demo#1': pr({
        state: 'MERGED',
        mergedAt: '2026-09-20T10:00:00Z',
        closedAt: '2026-09-20T10:00:00Z',
      }),
      'acme/demo#2': pr({ state: 'CLOSED', closedAt: '2026-09-21T09:00:00Z' }),
    });

    const result = await enrichPrs(graph, ghPrResolver({ run: gh }));

    expect(result).toMatchObject({ requested: 2, applied: 2, failed: false });
    expect(rowFor(1)).toMatchObject({
      state: 'merged',
      merged_at: '2026-09-20T10:00:00Z',
      closed_at: '2026-09-20T10:00:00Z',
    });
    expect(rowFor(2)).toMatchObject({
      state: 'closed',
      merged_at: null,
      closed_at: '2026-09-21T09:00:00Z',
    });
    expect(rowFor(2)?.outcome_checked_at).toEqual(expect.any(String));
  });

  it('passes reviews and commit times through, with no local round count', async () => {
    addPr(3);
    const gh = fakeGh({
      'acme/demo#3': pr({
        reviews: [
          { state: 'CHANGES_REQUESTED', submittedAt: '2026-09-20T01:00:00Z' },
          { state: 'APPROVED', submittedAt: '2026-09-20T05:00:00Z' },
          { state: 'COMMENTED', submittedAt: null },
        ],
        commits: [
          { committedDate: '2026-09-20T00:00:00Z' },
          { committedDate: '2026-09-20T02:00:00Z' },
          { committedDate: null },
        ],
      }),
    });

    const resolution = await ghPrResolver({ run: gh })(prsNeedingOutcome(graph));

    expect(resolution.get('pr:acme/demo#3')).toEqual({
      state: 'OPEN',
      mergedAt: null,
      closedAt: null,
      reviews: [
        { state: 'CHANGES_REQUESTED', submittedAt: '2026-09-20T01:00:00Z' },
        { state: 'APPROVED', submittedAt: '2026-09-20T05:00:00Z' },
      ],
      commitTimes: ['2026-09-20T00:00:00Z', '2026-09-20T02:00:00Z'],
    });
  });

  it('sends commit times as an empty array when a PR has no commits', async () => {
    addPr(4);
    const gh = fakeGh({ 'acme/demo#4': { state: 'OPEN' } });

    const resolution = await ghPrResolver({ run: gh })(prsNeedingOutcome(graph));

    expect(resolution.get('pr:acme/demo#4')).toMatchObject({ commitTimes: [], reviews: [] });
  });

  it('asks only for open PRs and PRs never checked, at most 50 per pass', async () => {
    const checked = '2026-09-22T00:00:00Z';
    addPr(1, { state: 'merged', checkedAt: checked });
    addPr(2, { state: 'closed', checkedAt: new Date().toISOString() });
    addPr(3, { state: 'open', checkedAt: checked });
    for (let n = 100; n < 160; n++) addPr(n);
    const gh = fakeGh({});

    await enrichPrs(graph, ghPrResolver({ run: gh }));

    expect(gh.asked).toHaveLength(50);
    expect(gh.asked).not.toContain('acme/demo#1');
    expect(gh.asked).not.toContain('acme/demo#2');
    // Never-checked PRs go before a PR checked on an earlier pass.
    expect(gh.asked).not.toContain('acme/demo#3');

    gh.asked.length = 0;
    await enrichPrs(graph, ghPrResolver({ run: gh }));

    expect(gh.asked).toHaveLength(11);
    expect(gh.asked).toContain('acme/demo#3');
  });

  it('a pass over 100 merged and checked PRs and 3 open ones polls only the 3 open', async () => {
    const root = path.join(dir, 'projects');
    mkdirSync(root, { recursive: true });
    const checked = '2026-09-22T00:00:00Z';
    for (let n = 1; n <= 100; n++) addPr(n, { state: 'merged', checkedAt: checked });
    for (const n of [201, 202, 203]) addPr(n, { state: 'open', checkedAt: checked });
    const gh = fakeGh({});

    const summary = await runRefresh({ graph, root, skipWorkspace: true, runGh: gh });

    expect(gh.asked.sort()).toEqual(['acme/demo#201', 'acme/demo#202', 'acme/demo#203']);
    expect(summary.prsPolled).toBe(3);
  });

  it('a gh answer with a wrong-typed field is reported in errors and leaves the PR unchecked', async () => {
    addPr(3);
    const gh = fakeGh({ 'acme/demo#3': pr({ reviews: 'not-a-list' }) });
    const errors: string[] = [];

    const resolution = await ghPrResolver({ run: gh, errors })(prsNeedingOutcome(graph));

    expect(resolution.size).toBe(0);
    expect(errors).toEqual(['prs: acme/demo#3: unexpected gh pr view output at reviews']);
  });

  it('a gh answer with unknown keys still resolves', async () => {
    addPr(4);
    const gh = fakeGh({ 'acme/demo#4': pr({ state: 'MERGED', isCrossRepository: false }) });

    const resolution = await ghPrResolver({ run: gh })(prsNeedingOutcome(graph));

    expect(resolution.get('pr:acme/demo#4')).toMatchObject({ state: 'MERGED' });
  });

  it('a gh failure is reported in errors and the pass succeeds', async () => {
    const root = path.join(dir, 'projects');
    mkdirSync(root, { recursive: true });
    addPr(7);
    addPr(8);
    addPr(9);
    const gh = fakeGh({
      'acme/demo#7': {
        code: 1,
        stdout: '',
        stderr: 'GraphQL: Could not resolve to a PullRequest\n',
      },
      'acme/demo#8': Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
      'acme/demo#9': pr({ state: 'CLOSED', closedAt: '2026-09-21T09:00:00Z' }),
    });

    const summary = await runRefresh({ graph, root, skipWorkspace: true, runGh: gh });

    expect(summary.errors).toEqual([
      'prs: acme/demo#7: GraphQL: Could not resolve to a PullRequest',
      'prs: acme/demo#8: spawn gh ENOENT',
    ]);
    expect(rowFor(7)).toMatchObject({ outcome_checked_at: null });
    expect(rowFor(8)).toMatchObject({ outcome_checked_at: null });
    expect(rowFor(9)).toMatchObject({ state: 'closed' });
  });

  it('does not ask gh again about a failed PR until the backoff has passed', async () => {
    const backoffMs = 30 * 60 * 1000;
    let clock = 1_000_000;
    addPr(1);
    const gh = fakeGh({ 'acme/demo#1': { code: 1, stdout: '', stderr: 'boom\n' } });
    const resolver = ghPrResolver({ run: gh, now: () => clock });

    await resolver(prsNeedingOutcome(graph));
    clock += backoffMs;
    await resolver(prsNeedingOutcome(graph));
    expect(gh.asked).toEqual(['acme/demo#1']);

    clock += 1;
    await resolver(prsNeedingOutcome(graph));
    expect(gh.asked).toEqual(['acme/demo#1', 'acme/demo#1']);
  });

  describe('recheck intervals', () => {
    const openMs = 10 * 60 * 1000;
    const closedMs = 24 * 60 * 60 * 1000;
    const checkedAt = '2026-11-01T00:00:00.000Z';
    const checkedMs = Date.parse(checkedAt);

    it('an open PR checked within the interval is not asked again', async () => {
      addPr(1, { state: 'open', checkedAt });
      const gh = fakeGh({});
      let clock = checkedMs + openMs - 1;
      const resolver = ghPrResolver({ run: gh, now: () => clock });

      await resolver(prsNeedingOutcome(graph));
      expect(gh.asked).toEqual([]);

      clock = checkedMs + openMs;
      await resolver(prsNeedingOutcome(graph));
      expect(gh.asked).toEqual(['acme/demo#1']);
    });

    it('a closed PR is re-checked after the interval', async () => {
      addPr(2, { state: 'closed', checkedAt });
      const gh = fakeGh({});
      let clock = checkedMs + closedMs - 1;
      const resolver = ghPrResolver({ run: gh, now: () => clock });

      await resolver(prsNeedingOutcome(graph));
      expect(gh.asked).toEqual([]);

      clock = checkedMs + closedMs;
      await resolver(prsNeedingOutcome(graph));
      expect(gh.asked).toEqual(['acme/demo#2']);
    });

    it('a merged PR the forge never checked is asked about, a checked one is not', async () => {
      addPr(4, { state: 'merged' });
      addPr(5, { state: 'merged', checkedAt });
      const gh = fakeGh({});
      const resolver = ghPrResolver({ run: gh, now: () => checkedMs + closedMs * 10 });

      await enrichPrs(graph, resolver);

      expect(gh.asked).toEqual(['acme/demo#4']);
    });

    it('a checked merged PR with no commit times is asked once, then final', async () => {
      addPr(6, { state: 'merged', checkedAt, commitTimes: null });
      const gh = fakeGh({ 'acme/demo#6': pr({ state: 'MERGED', mergedAt: checkedAt }) });
      const resolver = ghPrResolver({ run: gh, now: () => checkedMs + closedMs * 10 });

      await enrichPrs(graph, resolver);
      await enrichPrs(graph, resolver);

      expect(gh.asked).toEqual(['acme/demo#6']);
    });

    it('a checked merged PR missing commit times is asked inside the closed interval', async () => {
      addPr(7, { state: 'merged', checkedAt, commitTimes: null });
      const gh = fakeGh({ 'acme/demo#7': pr({ state: 'MERGED', mergedAt: checkedAt }) });
      const resolver = ghPrResolver({ run: gh, now: () => checkedMs + 1 });

      await enrichPrs(graph, resolver);

      expect(gh.asked).toEqual(['acme/demo#7']);
    });

    it('honours configured intervals over the defaults', async () => {
      addPr(3, { state: 'open', checkedAt });
      const gh = fakeGh({});
      const resolver = ghPrResolver({
        run: gh,
        now: () => checkedMs + 1000,
        openRecheckMs: 1000,
      });

      await resolver(prsNeedingOutcome(graph));

      expect(gh.asked).toEqual(['acme/demo#3']);
    });
  });
});
