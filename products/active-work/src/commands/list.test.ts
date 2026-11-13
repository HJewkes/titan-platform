import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import list from './list.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';

const brief = (prefix: string, rank: number, visibility?: string): string =>
  `---\nschema_version: 4\ntitle: Demo ${prefix}\nupdated: '2026-11-01'\nstate: focused\nrank: ${rank}\ntask_prefix: ${prefix}\n${visibility ? `visibility: ${visibility}\n` : ''}---\n# Demo\n`;

async function scaffold(activeRoot: string, slug: string, text: string): Promise<void> {
  await fs.mkdir(path.join(activeRoot, slug), { recursive: true });
  await fs.writeFile(path.join(activeRoot, slug, 'brief.md'), text);
}

describe('list', () => {
  it('names each initiative task prefix and whether agents may read it', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await scaffold(activeRoot, 'alpha', brief('AL', 1, 'agent-visible'));
      await scaffold(activeRoot, 'beta', brief('BE', 2));

      const result = await list.run({}, { activeRoot, warnings: [], format: 'json' });

      expect(result.parse_errors).toEqual([]);
      const items = result.sections.flatMap((section) => section.items);
      expect(items.map(({ slug, task_prefix, agent_visible }) => ({ slug, task_prefix, agent_visible }))).toEqual([
        { slug: 'alpha', task_prefix: 'AL', agent_visible: true },
        { slug: 'beta', task_prefix: 'BE', agent_visible: false },
      ]);
    });
  });
});
