import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../registry/types.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import open from './open.js';

/**
 * `open` is an MCP tool, so its picker and its slug-prefix errors are cross-initiative reads
 * (TP-5453 P6b). `alpha` declares itself agent-visible; `private-notes` declares nothing.
 */

const VISIBLE = 'alpha';
const HIDDEN = 'private-notes';

function writeBrief(root: string, slug: string, prefix: string, visibility: string): void {
  const dir = path.join(root, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'brief.md'),
    `---\nschema_version: 5\ntitle: ${slug} initiative\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: ${prefix}\n${visibility}---\n\nBody.\n`,
    'utf8',
  );
}

function seed(root: string): void {
  writeBrief(root, VISIBLE, 'AL', 'visibility: agent-visible\n');
  writeBrief(root, HIDDEN, 'PN', '');
}

function context(activeRoot: string, caller: CommandContext['caller']): CommandContext {
  return { activeRoot, warnings: [], format: 'json', caller };
}

function pickerSlugs(result: Awaited<ReturnType<typeof open.run>>): string[] {
  return 'initiatives' in result ? result.initiatives.map((row) => row.slug).sort() : [];
}

describe('open across initiatives', () => {
  it('the picker lists only agent-visible initiatives to an agent, and every one to the owner', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      const forAgent = await open.run(open.args.parse({ pick: true }), context(root, 'agent'));
      const forOwner = await open.run(open.args.parse({ pick: true }), context(root, 'owner'));

      expect(pickerSlugs(forAgent)).toEqual([VISIBLE]);
      expect(pickerSlugs(forOwner)).toEqual([VISIBLE, HIDDEN]);
    });
  });

  it('names no owner-only initiative to an agent when a slug matches nothing', async () => {
    await withEmptyActiveRoot(async (root) => {
      seed(root);

      const message = await open.run(open.args.parse({ slug: 'zzz' }), context(root, 'agent')).then(
        () => '',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );

      expect(message).toMatch(new RegExp(`Known: ${VISIBLE}$`));
    });
  });
});
