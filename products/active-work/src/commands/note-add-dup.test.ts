import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import noteAddCmd from './note-add.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';

const SLUG = 'sample-initiative';

function newCtx() {
  return { activeRoot: '', warnings: [] as string[], format: 'json' as const, caller: 'owner' as const };
}

async function seedNote(root: string, slug: string, filename: string, title: string): Promise<void> {
  const dir = path.join(root, slug, 'sources', 'notes');
  await fs.mkdir(dir, { recursive: true });
  const text = `---\nkind: fyi\ntitle: ${title}\ncreated: '2026-01-01'\n---\n\nbody\n`;
  await fs.writeFile(path.join(dir, filename), text, 'utf8');
}

describe('note.add possible duplicate', () => {
  it('flags a title matching an older note and still writes the file', async () => {
    await withTempActiveRoot(async (root) => {
      await seedNote(root, SLUG, '2026-01-01-env-paths-ignores-xdg.md', 'Env paths ignores XDG');
      const ctx = newCtx();
      const res = await noteAddCmd.run(
        { slug: SLUG, kind: 'fyi', title: 'Env paths ignores XDG', body: 'x' },
        ctx,
      );
      expect(res.possible_dup).toBe('2026-01-01-env-paths-ignores-xdg.md');
      expect(ctx.warnings.join('\n')).toContain('2026-01-01-env-paths-ignores-xdg.md');
      await expect(fs.access(res.path)).resolves.toBeUndefined();
    });
  });

  it('does not flag a different title', async () => {
    await withTempActiveRoot(async (root) => {
      await seedNote(root, SLUG, '2026-01-01-env-paths-ignores-xdg.md', 'Env paths ignores XDG');
      const ctx = newCtx();
      const res = await noteAddCmd.run(
        { slug: SLUG, kind: 'fyi', title: 'Lock files live beside the brief', body: 'x' },
        ctx,
      );
      expect(res.possible_dup).toBeUndefined();
      expect(ctx.warnings).toEqual([]);
      await expect(fs.access(res.path)).resolves.toBeUndefined();
    });
  });

  it('ignores a matching note in another initiative', async () => {
    await withTempActiveRoot(async (root) => {
      await seedNote(root, 'other-initiative', '2026-01-01-same.md', 'Env paths ignores XDG');
      const ctx = newCtx();
      const res = await noteAddCmd.run(
        { slug: SLUG, kind: 'fyi', title: 'Env paths ignores XDG', body: 'x' },
        ctx,
      );
      expect(res.possible_dup).toBeUndefined();
      expect(ctx.warnings).toEqual([]);
      await expect(fs.access(res.path)).resolves.toBeUndefined();
    });
  });
});
