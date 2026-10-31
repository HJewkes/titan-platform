import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../src/commands/index.js';
import {
  RELATED_DEADLINE_MS,
  warnRelatedTasks,
  type RelatedPort,
} from '../../src/commands/_task-related.js';
import { registry } from '../../src/registry/index.js';
import type { CommandContext } from '../../src/registry/types.js';
import type { Task } from '../../src/schemas/task.js';
import type { RelatedHit, RelatedResult } from '../../src/search/related.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'rel-test';
const QUERY = { terms: [], expression: '' };
const DONE_WHEN = 'the exporter writes every row and a test proves it';
const SLOW_SCORE_MS = 50;

function task(id: string, status: 'open' | 'done' = 'open'): Task {
  return { id, title: `Title of ${id}`, priority: 1, status, created: '2026-10-01', updated: '2026-10-01', done_at: null } as Task;
}

function hit(id: string, initiative: string = SLUG): RelatedHit {
  return {
    ref: `task:${id}`,
    class: 'tasks',
    initiative,
    title: null,
    path: null,
    excerpt: null,
    byteOffset: null,
    byteLength: null,
  };
}

const returning = (hits: RelatedHit[], degraded: RelatedResult['degraded'] = []): RelatedPort =>
  vi.fn(async () => ({ hits, degraded, query: QUERY }));

function context(): CommandContext {
  return { activeRoot: '/nonexistent', warnings: [], format: 'json', caller: 'agent' };
}

async function warningsFor(related: RelatedPort, existing: Task[]): Promise<string[]> {
  const ctx = context();
  await warnRelatedTasks(ctx, SLUG, task('RT-99'), existing, { related });
  return ctx.warnings;
}

describe('warnRelatedTasks', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('three open neighbours appear in warnings, a done neighbour is dropped', async () => {
    const related = returning([hit('RT-1'), hit('RT-2'), hit('RT-3'), hit('RT-4'), hit('RT-5')]);
    const existing = [task('RT-1'), task('RT-2', 'done'), task('RT-3'), task('RT-4'), task('RT-5')];

    expect(await warningsFor(related, existing)).toEqual([
      'related open task: RT-1 Title of RT-1',
      'related open task: RT-3 Title of RT-3',
      'related open task: RT-4 Title of RT-4',
    ]);
  });

  it('a related read that throws leaves the task filed and no warning', async () => {
    const asyncFailure: RelatedPort = () => Promise.reject(new Error('index gone'));
    const syncFailure: RelatedPort = () => {
      throw new Error('index gone');
    };

    expect(await warningsFor(asyncFailure, [task('RT-1')])).toEqual([]);
    expect(await warningsFor(syncFailure, [task('RT-1')])).toEqual([]);
  });

  it('a read past the deadline does not delay the result beyond it', async () => {
    vi.useFakeTimers();
    const ctx = context();
    const hung: RelatedPort = () => new Promise(() => {});
    let finished = false;

    const pending = warnRelatedTasks(ctx, SLUG, task('RT-99'), [task('RT-1')], {
      related: hung,
    }).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(RELATED_DEADLINE_MS - 1);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(finished).toBe(true);
    expect(ctx.warnings).toEqual([]);
  });

  it("the new task's own id is never listed", async () => {
    const related = returning([hit('RT-99'), hit('RT-1')]);

    const warnings = await warningsFor(related, [task('RT-1')]);

    expect(warnings).toEqual(['related open task: RT-1 Title of RT-1']);
    expect(related).toHaveBeenCalledWith(expect.objectContaining({ exclude: ['task:RT-99'] }));
  });

  it('a caller that is not an agent pays for no read and sees no list', async () => {
    const related = returning([hit('RT-1')]);
    const ctx: CommandContext = { ...context(), caller: undefined };

    await warnRelatedTasks(ctx, SLUG, task('RT-99'), [task('RT-1')], { related });

    expect(related).not.toHaveBeenCalled();
    expect(ctx.warnings).toEqual([]);
  });

  it('a degraded read prints nothing, even with hits', async () => {
    const degraded = [{ source: 'tasks', reason: 'error', message: 'partial' }];

    expect(await warningsFor(returning([hit('RT-1')], degraded), [task('RT-1')])).toEqual([]);
  });

  it('an id shared with another initiative is not mistaken for a local task', async () => {
    expect(await warningsFor(returning([hit('RT-1', 'other')]), [task('RT-1')])).toEqual([]);
  });

  it('a task the index lists twice is printed once', async () => {
    expect(await warningsFor(returning([hit('RT-1'), hit('RT-1')]), [task('RT-1')])).toHaveLength(1);
  });

  it('queries on the title and done_when, scoped to this initiative', async () => {
    const related = returning([]);
    const ctx = context();

    await warnRelatedTasks(ctx, SLUG, { ...task('RT-99'), done_when: DONE_WHEN }, [], { related });

    expect(related).toHaveBeenCalledWith(
      expect.objectContaining({
        text: `Title of RT-99\n${DONE_WHEN}`,
        initiative: SLUG,
      }),
    );
  });
});

interface Filed {
  id: string;
}

async function run<T = Filed>(ctx: CommandContext, name: string, args: unknown): Promise<T> {
  const cmd = registry.get(name);
  if (!cmd) throw new Error(`unknown command: ${name}`);
  return cmd.run(cmd.args.parse(args), ctx) as Promise<T>;
}

async function fileExporterTask(ctx: CommandContext, title: string): Promise<Filed> {
  return run(ctx, 'task.add', { slug: SLUG, title, done_when: DONE_WHEN });
}

async function withNeighbours(
  fn: (ctx: CommandContext, ids: { open: string; closed: string }) => Promise<void>,
): Promise<void> {
  await withEmptyActiveRoot(async (root) => {
    const setup: CommandContext = { activeRoot: root, warnings: [], format: 'json' };
    await run(setup, 'new', { slug: SLUG, title: 'Related' });
    const open = await fileExporterTask(setup, 'Build the parquet exporter');
    const closed = await fileExporterTask(setup, 'Retry the parquet exporter');
    await run(setup, 'task.done', { slug: SLUG, id: closed.id });
    await fn({ ...setup, warnings: [], caller: 'agent' }, { open: open.id, closed: closed.id });
  });
}

describe('task.add related list', () => {
  it('lists an open neighbour filed moments ago and skips the done one, with no index', async () => {
    await withNeighbours(async (ctx, { open, closed }) => {
      const filed = await fileExporterTask(ctx, 'Harden the parquet exporter');

      const warnings = ctx.warnings.join('\n');
      expect(warnings).toContain(open);
      expect(warnings).not.toContain(closed);
      expect(warnings).not.toContain(filed.id);
    });
  });

  it('with --quiet on a human surface the result stays the one line', async () => {
    await withNeighbours(async (ctx) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const human: CommandContext = { ...ctx, format: 'human' };

      const line = await run<string>(human, 'task.add', {
        slug: SLUG,
        title: 'Harden the parquet exporter',
        done_when: DONE_WHEN,
        quiet: true,
      });

      expect(line).toMatch(/^\S+ created\n$/);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('related open task:'));
      stderr.mockRestore();
    });
  });

  it('an injected slow search abandons at the deadline and the task stays filed', async () => {
    await withNeighbours(async (ctx) => {
      const filed = await fileExporterTask(ctx, 'Harden the parquet exporter');
      const tasks = Array.from({ length: 100 }, (_, n) => task(`RT-${n}`));
      let clock = 0;
      const score = vi.fn(() => {
        clock += SLOW_SCORE_MS;
        return 1;
      });
      const warned: CommandContext = { ...ctx, warnings: [] };

      await warnRelatedTasks(warned, SLUG, task(filed.id), tasks, {
        scan: { score, now: () => clock },
      });

      expect(clock).toBeLessThanOrEqual(RELATED_DEADLINE_MS);
      expect(score.mock.calls.length).toBeLessThan(tasks.length);
      expect(warned.warnings).toEqual([]);
      const listed = await run<{ tasks: Filed[] }>(ctx, 'task.list', { slug: SLUG });
      expect(listed.tasks.map(({ id }) => id)).toContain(filed.id);
    });
  });

  it('a corrupt graph file cannot touch the list, because the add never opens it', async () => {
    await withNeighbours(async (ctx, { open }) => {
      await fs.mkdir(path.join(ctx.activeRoot, '.miner'), { recursive: true });
      await fs.writeFile(path.join(ctx.activeRoot, '.miner', 'graph.sqlite3'), 'not a database');

      await fileExporterTask(ctx, 'Harden the parquet exporter');

      expect(ctx.warnings.join('\n')).toContain(open);
    });
  });
});
