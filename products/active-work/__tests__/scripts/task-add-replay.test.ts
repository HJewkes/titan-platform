import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error — importing a plain .mjs (no type declarations) from a test.
import { loadRoot, renderReport, replay } from '../../scripts/task-add-replay.mjs';

const PRODUCT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(PRODUCT_ROOT, 'scripts', 'task-add-replay.mjs');

const NOW = '2026-03-20T00:00:00.000Z';
const USABLE = 'the widget renders with a checkable outcome in the suite';

interface Band {
  threshold: number;
  flagged_tasks: number;
  pairs_at_or_above: number;
  pairs_in_band: number;
  sampled: { id: string; earlier_id: string }[];
}

interface Replay {
  tasks_in_window: number;
  refused: Record<string, number>;
  bands: Band[];
}

function task(id: string, title: string, created: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    priority: 1,
    status: 'open',
    tags: [],
    created,
    updated: created,
    done_at: null,
    done_when: USABLE,
    ...extra,
  };
}

const run = (tasks: ReturnType<typeof task>[], sample = 20): Replay =>
  replay(new Map([['demo', tasks]]), { now: Date.parse(NOW), days: 14, sample }) as Replay;

const bandAt = (result: Replay, threshold: number): Band => {
  const band = result.bands.find((b) => b.threshold === threshold);
  if (band === undefined) throw new Error(`no band ${threshold}`);
  return band;
};

describe('replay', () => {
  const fixture = [
    task('DM-1', 'alpha beta gamma delta epsilon zeta', '2026-02-01T00:00:00.000Z'),
    task('DM-2', 'alpha beta gamma delta epsilon eta', '2026-03-10T00:00:00.000Z'),
    task('DM-3', 'unrelated words only here', '2026-03-11T00:00:00.000Z', { done_when: undefined }),
  ];

  it('counts one refusal, one near-duplicate pair and leaves out the task outside the window', () => {
    const result = run(fixture);

    expect(result.tasks_in_window).toBe(2);
    expect(result.refused).toEqual({ 'done_when is missing': 1 });
    expect(result.bands.map((b) => b.flagged_tasks)).toEqual([1, 1, 1, 1, 0, 0]);
    expect(result.bands.map((b) => b.pairs_in_band)).toEqual([0, 0, 0, 1, 0, 0]);
  });

  it('samples the pair with the new task and the earlier task named', () => {
    expect(bandAt(run(fixture), 0.7).sampled).toMatchObject([{ id: 'DM-2', earlier_id: 'DM-1' }]);
  });

  it('counts a score exactly on a threshold as at or above it', () => {
    const result = run([
      task('DM-1', 'one two three four', '2026-03-10T00:00:00.000Z'),
      task('DM-2', 'one two three five six', '2026-03-11T00:00:00.000Z'),
    ]);

    expect(bandAt(result, 0.5).pairs_at_or_above).toBe(1);
    expect(bandAt(result, 0.5).pairs_in_band).toBe(1);
    expect(bandAt(result, 0.6).pairs_at_or_above).toBe(0);
  });

  it('does not pair a task with one closed before it was filed, but does with one closed after', () => {
    const closedBefore = task('DM-1', 'same title words here', '2026-03-01T00:00:00.000Z', {
      status: 'done',
      done_at: '2026-03-05T00:00:00.000Z',
    });
    const closedAfter = task('DM-2', 'same title words here', '2026-03-02T00:00:00.000Z', {
      status: 'done',
      done_at: '2026-03-15T00:00:00.000Z',
    });
    const fresh = task('DM-3', 'same title words here', '2026-03-10T00:00:00.000Z');

    const top = bandAt(run([closedBefore, closedAfter, fresh]), 0.9);

    expect(top.sampled.filter((p) => p.id === 'DM-3').map((p) => p.earlier_id)).toEqual(['DM-2']);
  });

  it('does not pair tasks across initiatives', () => {
    const result = replay(
      new Map([
        ['one', [task('DM-1', 'same title words here', '2026-03-10T00:00:00.000Z')]],
        ['two', [task('DM-2', 'same title words here', '2026-03-11T00:00:00.000Z')]],
      ]),
      { now: Date.parse(NOW) },
    ) as Replay;

    expect(bandAt(result, 0.4).pairs_at_or_above).toBe(0);
  });

  it('takes the first filed of two same-day date-only tasks as the earlier one', () => {
    const result = run([
      task('DM-10', 'same title words here', '2026-03-10'),
      task('DM-9', 'same title words here', '2026-03-10'),
    ]);

    expect(bandAt(result, 0.9).sampled).toMatchObject([{ id: 'DM-10', earlier_id: 'DM-9' }]);
  });

  it('caps each band at the sample size and flags a task once however many pairs it has', () => {
    const earlier = ['DM-1', 'DM-2', 'DM-3'].map((id) => task(id, 'same title words here', '2026-02-01T00:00:00.000Z'));

    const top = bandAt(run([...earlier, task('DM-4', 'same title words here', '2026-03-10T00:00:00.000Z')], 2), 0.9);

    expect(top.flagged_tasks).toBe(1);
    expect(top.pairs_in_band).toBe(3);
    expect(top.sampled).toHaveLength(2);
  });
});

describe('the script over a fixture root', () => {
  let root: string;

  const write = (slug: string, tasks: ReturnType<typeof task>[]): void => {
    const dir = path.join(root, slug, 'tasks');
    mkdirSync(dir, { recursive: true });
    for (const t of tasks) writeFileSync(path.join(dir, `${t.id}.yml`), YAML.stringify(t));
  };

  const snapshot = (): Record<string, string> => {
    const files: Record<string, string> = {};
    for (const name of readdirSync(root, { recursive: true }) as string[]) {
      const file = path.join(root, name);
      if (statSync(file).isFile()) files[name] = `${statSync(file).mtimeMs}:${readFileSync(file, 'utf8')}`;
    }
    return files;
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'task-add-replay-'));
    write('demo', [
      task('DM-1', 'alpha beta gamma delta epsilon zeta', '2026-02-01T00:00:00.000Z'),
      task('DM-2', 'alpha beta gamma delta epsilon eta', '2026-03-10T00:00:00.000Z', { done_when: 'merged' }),
    ]);
    writeFileSync(path.join(root, 'demo', 'tasks', 'DM-3.yml'), ': not a task : [');
    mkdirSync(path.join(root, 'no-tasks-here'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('skips and counts a file that does not parse', async () => {
    const { bySlug, unreadable } = await loadRoot(root);

    expect(unreadable).toBe(1);
    expect([...bySlug.keys()]).toEqual(['demo']);
  });

  it('prints the counts and sampled pair and changes nothing under the root', () => {
    const before = snapshot();

    const result = spawnSync(process.execPath, [SCRIPT, '--root', root, '--now', NOW], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Tasks created: 1. Unreadable files skipped: 1.');
    expect(result.stdout).toContain('## Refused by doneWhenProblem: 1');
    expect(result.stdout).toContain('| 0.7 | 1 | 100 | 1 |');
    expect(result.stdout).toContain('| DM-2 | alpha beta gamma delta epsilon eta | DM-1 |');
    expect(snapshot()).toEqual(before);
  });

  it('escapes a pipe in a title so a table row keeps its columns', () => {
    const output = renderReport({
      ...(run([]) as object),
      unreadable: 0,
      bands: [
        {
          threshold: 0.9,
          flagged_tasks: 0,
          flagged_pct: 0,
          pairs_at_or_above: 0,
          band: '0.9-1.0',
          pairs_in_band: 1,
          sampled: [{ score: 1, id: 'DM-2', title: 'a | b', earlier_id: 'DM-1', earlier_title: 'c' }],
        },
      ],
    });

    expect(output).toContain('a \\| b');
  });
});
