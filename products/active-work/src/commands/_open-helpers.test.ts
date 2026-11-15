import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { NotFoundError } from '../errors.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import { resolveSlug } from './_open-helpers.js';

function writeInitiative(root: string, slug: string): void {
  const dir = path.join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'brief.md'),
    `---\nschema_version: 5\ntitle: ${slug}\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: XX\n---\n\nBody.\n`,
    'utf8',
  );
}

async function failure(root: string, input: string): Promise<NotFoundError> {
  const error = await resolveSlug(root, input, { caller: 'owner', warnings: [] }).then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof NotFoundError)) throw new Error('expected a NotFoundError');
  return error;
}

describe('resolveSlug when nothing matches by prefix', () => {
  it('suggests a slug that contains the input, ignoring case', async () => {
    await withEmptyActiveRoot(async (root) => {
      writeInitiative(root, 'titan-platform');
      writeInitiative(root, 'relay');

      const error = await failure(root, 'PLATFORM');

      expect(error.message).toContain('Did you mean: titan-platform');
      expect(error.message).toContain('Known: relay, titan-platform');
      expect(error.reason).toBe('no_match');
    });
  });

  it('adds no Did-you-mean line when no slug contains the input', async () => {
    await withEmptyActiveRoot(async (root) => {
      writeInitiative(root, 'titan-platform');

      const error = await failure(root, 'zzz');

      expect(error.message).not.toContain('Did you mean');
    });
  });

  it('caps the Known list at 12 and points at the list command', async () => {
    await withEmptyActiveRoot(async (root) => {
      for (let i = 0; i < 30; i++) writeInitiative(root, `init-${String(i).padStart(2, '0')}`);

      const error = await failure(root, 'zzz');

      expect(error.message).toContain('init-11');
      expect(error.message).not.toContain('init-12');
      expect(error.message).toContain('(+18 more — `active-work list`)');
    });
  });

  it('keeps the plain message for three initiatives', async () => {
    await withEmptyActiveRoot(async (root) => {
      for (const slug of ['a-one', 'b-two', 'c-three']) writeInitiative(root, slug);

      const error = await failure(root, 'zzz');

      expect(error.message).toBe("No initiative matches 'zzz'. Known: a-one, b-two, c-three");
    });
  });
});
