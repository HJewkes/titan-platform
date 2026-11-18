import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import digest from './digest.js';
import { UsageError } from '../errors.js';
import type { CommandContext } from '../registry/index.js';
import { writeSessionFile } from '../sessions/session-file.js';
import { withEmptyActiveRoot, writeAgentVisibleBrief } from '../test-support/test-helpers.js';

const PERSONAL = 'home-errands';
const SHARED = 'shared-work';
const DAY_MS = 24 * 60 * 60 * 1000;

function dayOffset(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

interface TaskSeed {
  id: string;
  due?: string;
  updated?: string;
  status?: string;
}

async function writeOwnerOnlyBrief(root: string, slug: string): Promise<void> {
  await fs.mkdir(path.join(root, slug), { recursive: true });
  await fs.writeFile(path.join(root, slug, 'brief.md'), '---\nvisibility: owner-only\n---\n', 'utf8');
}

async function writeTask(root: string, slug: string, seed: TaskSeed): Promise<void> {
  const dir = path.join(root, slug, 'tasks');
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    `id: ${seed.id}`,
    `title: "Task ${seed.id}"`,
    'priority: 2',
    `status: ${seed.status ?? 'open'}`,
    `created: ${dayOffset(-400)}`,
    `updated: ${seed.updated ?? dayOffset(-1)}`,
    'done_at: null',
    ...(seed.due ? [`due: ${seed.due}`] : []),
  ];
  await fs.writeFile(path.join(dir, `${seed.id}.yml`), `${lines.join('\n')}\n`, 'utf8');
}

async function openDueLoop(root: string, slug: string, id: string): Promise<void> {
  const opened = new Date(Date.now() - 3 * DAY_MS).toISOString();
  await writeSessionFile({
    slug,
    activeRoot: root,
    session_id: `sess-${id}`,
    started: opened,
    ended: opened,
    track: 'canonical',
    body: 'narrative\n',
    next_steps: [{ id, text: `follow up ${id}`, kind: 'prose', due: dayOffset(-1) + 'T00:00:00Z' }],
  });
}

async function seedPersonal(root: string): Promise<void> {
  writeAgentVisibleBrief(root, SHARED);
  await writeOwnerOnlyBrief(root, PERSONAL);
  await writeTask(root, PERSONAL, { id: 'HE-1', due: dayOffset(-2) });
  await writeTask(root, PERSONAL, { id: 'HE-2', due: dayOffset(5) });
  await writeTask(root, PERSONAL, { id: 'HE-3', due: dayOffset(30) });
  await writeTask(root, PERSONAL, { id: 'HE-4', updated: dayOffset(-90) });
  await writeTask(root, PERSONAL, { id: 'HE-5', due: dayOffset(-9), status: 'done' });
  await writeTask(root, SHARED, { id: 'SW-1', due: dayOffset(-2) });
  await openDueLoop(root, PERSONAL, 'call-back');
}

function ctxFor(root: string, caller: 'owner' | 'agent'): CommandContext {
  return { activeRoot: root, warnings: [], format: 'json', caller };
}

async function run(ctx: CommandContext) {
  const result = await digest.run(digest.args.parse({ personal: true, offline: true }), ctx);
  if (typeof result === 'string') throw new Error('expected a structured digest');
  return result;
}

describe('digest --personal', () => {
  it('lists overdue, next-14-day, trigger-met and stale items in that order', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seedPersonal(root);

      const result = await run(ctxFor(root, 'owner'));

      const headers = result.lines.filter((line) => !line.startsWith(' '));
      expect(headers.slice(1).map((line) => line.split(' (')[0])).toEqual([
        'Overdue',
        'Due in the next 14 days',
        'Trigger-met loops',
        'Stale over 60 days',
      ]);
      expect(result.overdue.map((t) => t.id)).toEqual(['HE-1']);
      expect(result.upcoming.map((t) => t.id)).toEqual(['HE-2']);
      expect(result.loops.map((l) => l.ref.split('#')[1])).toEqual(['call-back']);
      expect(result.stale.map((t) => t.id)).toEqual(['HE-4']);
    });
  });

  it('caps the listing at 30 lines and keeps only the top five stale items', async () => {
    await withEmptyActiveRoot(async (root) => {
      await writeOwnerOnlyBrief(root, PERSONAL);
      for (let i = 1; i <= 40; i++) {
        await writeTask(root, PERSONAL, { id: `HE-${i}`, due: dayOffset(-i), updated: dayOffset(-100 - i) });
      }
      for (let i = 41; i <= 50; i++) {
        await writeTask(root, PERSONAL, { id: `HE-${i}`, updated: dayOffset(-100 - i) });
      }

      const result = await run(ctxFor(root, 'owner'));

      expect(result.lines).toHaveLength(30);
      expect(result.lines.at(-1)).toMatch(/more lines? withheld/);
      expect(result.stale.map((t) => t.id)).toEqual(['HE-50', 'HE-49', 'HE-48', 'HE-47', 'HE-46']);
    });
  });

  it('serves an agent caller no row from an owner-only initiative', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seedPersonal(root);

      const result = await run(ctxFor(root, 'agent'));

      const rows = [...result.overdue, ...result.upcoming, ...result.stale];
      expect(rows).toEqual([]);
      expect(result.loops).toEqual([]);
      expect(result.lines.join('\n')).not.toContain(PERSONAL);
      expect(result.lines.join('\n')).not.toContain('SW-1');
    });
  });

  it('prints every section with a none line when there is nothing to list', async () => {
    await withEmptyActiveRoot(async (root) => {
      await writeOwnerOnlyBrief(root, PERSONAL);

      const result = await run(ctxFor(root, 'owner'));

      expect(result.lines.filter((line) => line === '  none')).toHaveLength(4);
    });
  });

  it('refuses to run without --personal', async () => {
    await withEmptyActiveRoot(async (root) => {
      const args = digest.args.parse({});

      await expect(digest.run(args, ctxFor(root, 'owner'))).rejects.toBeInstanceOf(UsageError);
    });
  });
});
