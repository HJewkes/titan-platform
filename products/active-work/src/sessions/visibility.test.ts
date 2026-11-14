import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CommandContext } from '../registry/types.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import { CHARTER_INITIATIVE, writeCharter } from '../test-support/visibility.js';
import { requireOwner, visibilityFor, withheldSlugs, type Shown } from './visibility.js';

/**
 * The one visibility decision (TP-5556): an agent is shown an initiative only when its brief
 * allows agents, the charter is readable and the charter does not list it human-only.
 */

const BRIEF_HEAD = 'schema_version: 5\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: XX\n';

function writeBrief(root: string, slug: string, visibility: string): void {
  mkdirSync(path.join(root, slug), { recursive: true });
  writeFileSync(path.join(root, slug, 'brief.md'), `---\ntitle: ${slug}\n${BRIEF_HEAD}${visibility}---\n\nBody.\n`, 'utf8');
}

function seed(root: string): void {
  writeCharter(root, ['garden-plan']);
  writeBrief(root, 'alpha', 'visibility: agent-visible\n');
  writeBrief(root, 'private-notes', '');
  writeBrief(root, 'garden-plan', 'visibility: agent-visible\n');
}

function context(activeRoot: string, caller?: CommandContext['caller']): CommandContext {
  return { activeRoot, warnings: [], format: 'json', ...(caller ? { caller } : {}) };
}

function verdicts(shown: Shown, names: readonly (string | null)[]): boolean[] {
  return names.map((name) => shown(name));
}

describe('visibilityFor', () => {
  it('shows an agent only initiatives the brief and the charter both allow', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const ctx = context(root, 'agent');

      const shown = await visibilityFor(ctx);

      expect(verdicts(shown, ['alpha', 'private-notes', 'garden-plan', CHARTER_INITIATIVE])).toEqual([
        true,
        false,
        false,
        false,
      ]);
      expect(ctx.warnings).toEqual(['3 owner-only initiatives hidden from a non-owner caller']);
    });
  });

  it('shows an agent no initiative and no unassigned row while the charter is unreadable', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      rmSync(path.join(root, CHARTER_INITIATIVE), { recursive: true });

      const shown = await visibilityFor(context(root, 'agent'));

      expect(verdicts(shown, ['alpha', null])).toEqual([false, false]);
    });
  });

  it('shows an agent nothing from an active root it cannot read', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const notADirectory = path.join(root, 'alpha', 'brief.md');
      const ctx = context(notADirectory, 'agent');

      const shown = await visibilityFor(ctx);

      expect(verdicts(shown, ['alpha', null])).toEqual([false, false]);
      expect(ctx.warnings.join('\n')).not.toContain('alpha');
    });
  });

  it('never shows an agent a name from history that is no longer on disk', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      const shown = await visibilityFor(context(root, 'agent'));

      expect(shown('archived-plans')).toBe(false);
    });
  });

  it('serves the owner every initiative, history and unassigned rows included', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      const ctx = context(root, 'owner');

      const shown = await visibilityFor(ctx);

      expect(verdicts(shown, ['private-notes', 'garden-plan', 'archived-plans', null])).toEqual([true, true, true, true]);
      expect(ctx.warnings).toEqual([]);
    });
  });

  it('restricts a caller no surface marked exactly as it restricts an agent', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      const shown = await visibilityFor(context(root));

      expect(verdicts(shown, ['alpha', 'private-notes', 'garden-plan', null])).toEqual([true, false, false, false]);
    });
  });

  it('accepts only a Shown it built, never a plain predicate', () => {
    expectTypeOf<(initiative: string | null) => boolean>().not.toExtend<Shown>();
  });
});

describe('requireOwner', () => {
  it.each([
    ['an agent', 'agent' as const],
    ['a caller no surface marked', undefined],
  ])('refuses %s', (_who, caller) => {
    expect(() => requireOwner(caller ? { caller } : {}, 'migrate')).toThrow(/migrate is for the owner only/);
  });

  it('lets the owner through', () => {
    expect(() => requireOwner({ caller: 'owner' }, 'migrate')).not.toThrow();
  });
});

describe('withheldSlugs', () => {
  it('withholds human-only and owner-only initiatives alike', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      expect((await withheldSlugs(root)).sort()).toEqual([CHARTER_INITIATIVE, 'garden-plan', 'private-notes']);
    });
  });

  it('withholds every initiative while the charter is unreadable', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);
      rmSync(path.join(root, CHARTER_INITIATIVE), { recursive: true });

      expect((await withheldSlugs(root)).sort()).toEqual(['alpha', 'garden-plan', 'private-notes']);
    });
  });
});
