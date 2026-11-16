import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../registry/index.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';

const STARTUP_WAIT_MS = 2000;

const gate = vi.hoisted(() => ({
  liveStarted: undefined as undefined | (() => void),
  liveStartedPromise: undefined as undefined | Promise<void>,
}));

vi.mock('../bootstrap/live-status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bootstrap/live-status.js')>()),
  defaultLiveStatusFetcher: async () => {
    gate.liveStarted?.();
    return [];
  },
}));

vi.mock('../bootstrap/archive-tasks.js', () => ({
  archiveStaleTasks: async () => {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('archive finished before live status started')), STARTUP_WAIT_MS);
    });
    await Promise.race([gate.liveStartedPromise, timeout]);
    return { archivedIds: [], tasks: [], malformed: [] };
  },
}));

const { default: openCommand } = await import('./open.js');

async function seedInitiative(root: string, slug: string): Promise<void> {
  const dir = path.join(root, slug);
  await fs.mkdir(path.join(dir, 'tasks'), { recursive: true });
  await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'brief.md'),
    ['---', 'schema_version: 1', 'title: Sample', 'updated: 2026-05-12', 'state: focused', 'task_prefix: SM', '---', '', '# Sample', ''].join('\n'),
  );
  await fs.writeFile(
    path.join(dir, 'artifacts.yml'),
    'branches:\n  - repo: ~/code/sample\n    name: feat/sample\nstashes: []\nworktrees: []\n',
  );
}

describe('open command live status and archive overlap', () => {
  it('starts the live branch lookup before the archive pass completes', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await seedInitiative(activeRoot, 'sample');
      gate.liveStartedPromise = new Promise<void>((resolve) => {
        gate.liveStarted = resolve;
      });
      const ctx: CommandContext = { activeRoot, warnings: [], format: 'json', caller: 'owner' };

      const out = await openCommand.run({ slug: 'sample', detectSiblings: false }, ctx);

      expect(out).toMatchObject({ slug: 'sample' });
    });
  });
});
