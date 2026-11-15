import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveSlugFromCwd } from './initiatives.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';

const VALID_BRIEF = [
  '---',
  'schema_version: 1',
  'title: Sample',
  'updated: 2026-05-12',
  'state: backburner',
  'task_prefix: SM',
  '---',
  '',
  '# Sample',
  '',
].join('\n');

async function makeInitiative(
  activeRoot: string,
  slug: string,
  options: { brief?: string; worktree?: string } = {},
): Promise<string> {
  const dir = path.join(activeRoot, slug);
  await fs.mkdir(path.join(dir, 'sources'), { recursive: true });
  await fs.writeFile(path.join(dir, 'brief.md'), options.brief ?? VALID_BRIEF);
  if (options.worktree !== undefined) {
    await fs.writeFile(
      path.join(dir, 'artifacts.yml'),
      `branches: []\nstashes: []\nworktrees:\n  - path: ${options.worktree}\n    repo: ${options.worktree}\n    name: main\n    default: true\n`,
    );
  }
  return dir;
}

describe('resolveSlugFromCwd with the initiative directory', () => {
  it('resolves a cwd equal to the initiative directory', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const dir = await makeInitiative(activeRoot, 'alpha');

      const match = await resolveSlugFromCwd(activeRoot, dir);

      expect(match).toEqual({ slug: 'alpha', worktreePath: dir });
    });
  });

  it('resolves a cwd inside the initiative directory to that directory', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const dir = await makeInitiative(activeRoot, 'alpha');

      const match = await resolveSlugFromCwd(activeRoot, path.join(dir, 'sources'));

      expect(match).toEqual({ slug: 'alpha', worktreePath: dir });
    });
  });

  it('skips an initiative whose brief cannot be read', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const dir = await makeInitiative(activeRoot, 'broken', { brief: 'not frontmatter' });

      expect(await resolveSlugFromCwd(activeRoot, dir)).toBeNull();
    });
  });

  it('returns null for the active root itself', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await makeInitiative(activeRoot, 'alpha');

      expect(await resolveSlugFromCwd(activeRoot, activeRoot)).toBeNull();
    });
  });

  it('prefers a registered worktree nested under the initiative directory', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const worktree = path.join(activeRoot, 'alpha', 'sources', 'checkout');
      const dir = await makeInitiative(activeRoot, 'alpha', { worktree });
      await fs.mkdir(worktree, { recursive: true });

      const match = await resolveSlugFromCwd(activeRoot, worktree);

      expect(match).toEqual({ slug: 'alpha', worktreePath: worktree });
      expect(match?.worktreePath).not.toBe(dir);
    });
  });
});
