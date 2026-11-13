import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import taskKeys from './task-keys.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';

const brief = (prefix: string, rank: number, visibility?: string): string =>
  `---\nschema_version: 4\ntitle: Demo ${prefix}\nupdated: '2026-11-01'\nstate: focused\nrank: ${rank}\ntask_prefix: ${prefix}\n${visibility ? `visibility: ${visibility}\n` : ''}---\n# Demo\n`;

async function scaffold(activeRoot: string, slug: string, text: string, files: Record<string, string> = {}): Promise<void> {
  await fs.mkdir(path.join(activeRoot, slug, 'tasks', 'archive'), { recursive: true });
  await fs.writeFile(path.join(activeRoot, slug, 'brief.md'), text);
  for (const [file, body] of Object.entries(files)) await fs.writeFile(path.join(activeRoot, slug, 'tasks', file), body);
}

describe('task.keys', () => {
  it('lists each initiative for the owner with its task prefix, visibility and the ids of open and archived task files', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await scaffold(activeRoot, 'alpha', brief('AL', 1, 'agent-visible'), { 'AL-2.yml': 'not: parsed', 'archive/AL-1.yml': '', 'notes.txt': '' });
      await scaffold(activeRoot, 'beta', brief('BE', 2));

      const result = await taskKeys.run({}, { activeRoot, warnings: [], format: 'json', caller: 'owner' });

      expect(result.initiatives).toEqual([
        { slug: 'alpha', task_prefix: 'AL', agent_visible: true, ids: ['AL-1', 'AL-2'] },
        { slug: 'beta', task_prefix: 'BE', agent_visible: false, ids: [] },
      ]);
    });
  });

  it('hides owner-only initiatives from an agent and says how many', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await scaffold(activeRoot, 'alpha', brief('AL', 1, 'agent-visible'), { 'AL-1.yml': '' });
      await scaffold(activeRoot, 'beta', brief('BE', 2), { 'BE-1.yml': '' });
      const warnings: string[] = [];

      const result = await taskKeys.run({}, { activeRoot, warnings, format: 'json', caller: 'agent' });

      expect(result.initiatives.map(({ slug }) => slug)).toEqual(['alpha']);
      expect(warnings).toHaveLength(1);
    });
  });
});
