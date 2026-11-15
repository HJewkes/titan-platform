import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import './index.js';
import { registry } from '../registry/index.js';
import type { CommandContext } from '../registry/types.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';

const RowSchema = z.looseObject({ id: z.string(), due: z.string().optional() });

async function runRaw(name: string, args: unknown, activeRoot: string) {
  const cmd = registry.get(name);
  if (!cmd) throw new Error(`unknown command: ${name}`);
  const ctx: CommandContext = { activeRoot, warnings: [], format: 'json' };
  return cmd.run(cmd.args.parse(args), ctx);
}

async function withInitiative(fn: (root: string) => Promise<void>): Promise<void> {
  await withEmptyActiveRoot(async (root) => {
    await runRaw('new', { slug: 'due-test', title: 'Due' }, root);
    await fn(root);
  });
}

async function addWithDue(root: string, due: string) {
  return RowSchema.parse(await runRaw('task.add', { slug: 'due-test', title: 'T', due }, root));
}

function setToday(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${iso}T12:00:00`));
}

describe('relative due dates', () => {
  beforeEach(() => setToday('2026-11-15'));
  afterEach(() => vi.useRealTimers());

  it('task add --due +3d stores today plus three days', async () => {
    await withInitiative(async (root) => {
      expect((await addWithDue(root, '+3d')).due).toBe('2026-11-18');
    });
  });

  it('task edit --due +2w stores today plus fourteen days', async () => {
    await withInitiative(async (root) => {
      const { id } = await addWithDue(root, '2026-12-01');
      await runRaw('task.edit', { slug: 'due-test', id, due: '+2w' }, root);
      const edited = RowSchema.parse(await runRaw('task.show', { slug: 'due-test', id }, root));
      expect(edited.due).toBe('2026-11-29');
    });
  });

  it('rolls over a month end', async () => {
    vi.setSystemTime(new Date('2026-01-30T12:00:00'));
    await withInitiative(async (root) => {
      expect((await addWithDue(root, '+3d')).due).toBe('2026-02-02');
    });
  });

  it('passes an absolute date through', async () => {
    await withInitiative(async (root) => {
      expect((await addWithDue(root, '2027-03-09')).due).toBe('2027-03-09');
    });
  });

  it.each(['+0d', '-3d', '3d', '+3m', '+d', '+1.5d'])('refuses %s naming the accepted forms', async (bad) => {
    await withInitiative(async (root) => {
      await expect(addWithDue(root, bad)).rejects.toThrow(/YYYY-MM-DD, \+Nd or \+Nw/);
    });
  });
});
