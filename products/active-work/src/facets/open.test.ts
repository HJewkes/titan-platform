import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import openCommand, { sessionAbout } from '../commands/open.js';
import type { LoadedFacet } from './facet-file.js';
import type { CommandContext } from '../registry/index.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';
import { writeCharter } from '../test-support/visibility.js';
import { SAMPLE_SLUG, writeFacet } from '../test-support/facets/fixtures.js';

function makeCtx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

const openEnvelope = z.object({
  slug: z.string(),
  prompt: z.string(),
  facet: z
    .object({
      name: z.string(),
      tags: z.array(z.string()),
      about: z.string().optional(),
    })
    .optional(),
  metadata: z.object({ facet: z.string().optional() }),
});
type OpenEnvelope = z.infer<typeof openEnvelope>;

async function openAlias(activeRoot: string, about?: string): Promise<OpenEnvelope> {
  await writeFacet(
    activeRoot,
    SAMPLE_SLUG,
    'widgets',
    ['tags: [example]', 'about: the widget area'],
    'Widgets body.',
  );
  const args = { slug: 'widgets', offline: true, ...(about ? { about } : {}) };
  const out = await openCommand.run(openCommand.args.parse(args), makeCtx(activeRoot));
  return openEnvelope.parse(out);
}

describe('open through a facet alias', () => {
  it('opens the owning initiative and carries the facet on the envelope', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      writeCharter(activeRoot);
      const result = await openAlias(activeRoot);

      expect(result.slug).toBe(SAMPLE_SLUG);
      expect(result.facet).toEqual({
        name: 'widgets',
        tags: ['example'],
        about: 'the widget area',
      });
      expect(result.metadata.facet).toBe('widgets');
      expect(result.prompt).toContain('# Facet: widgets\nWidgets body.');
    });
  });
});

describe('sessionAbout', () => {
  const facet: LoadedFacet = {
    name: 'widgets',
    owner: SAMPLE_SLUG,
    tags: ['ui'],
    about: 'the widget area',
    body: '',
    path: '/unused',
  };

  it('lets an explicit --about win over the facet about', () => {
    expect(sessionAbout('the login bug', facet)).toBe('the login bug');
  });

  it('falls back to the facet about', () => {
    expect(sessionAbout(undefined, facet)).toBe('the widget area');
  });
});
