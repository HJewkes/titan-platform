import { promises as fs } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { describe, expect, it } from 'vitest';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';
import { runCliAsync, runCliInProcess } from './cli-runner.js';

const WRITERS = 12;
const HOLD_MS = 1_500;

async function arrange(activeRoot: string, args: string[]): Promise<void> {
  const result = await runCliInProcess(args, { ACTIVE_ROOT: activeRoot });
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr}`);
}

describe('task edit under concurrent writers', () => {
  it('keeps every --append line when 12 processes queue behind a held lock', async () => {
    await withEmptyActiveRoot(async (root) => {
      // Arrange
      await arrange(root, ['new', 'demo', '--title', 'Demo']);
      await arrange(root, ['task', 'add', 'demo', '--title', 'Shared task']);
      const release = await lockfile.lock(path.join(root, 'demo', '.lock'), { realpath: false });
      const lines = Array.from({ length: WRITERS }, (_, i) => `note-${i}-end`);

      // Act
      const runs = lines.map((line) =>
        runCliAsync(['task', 'edit', 'demo', 'D-1', '--append', line], { ACTIVE_ROOT: root }),
      );
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      await release();
      const results = await Promise.all(runs);

      // Assert
      expect(results.filter((r) => r.status !== 0)).toEqual([]);
      const yaml = await fs.readFile(path.join(root, 'demo', 'tasks', 'D-1.yml'), 'utf8');
      for (const line of lines) expect(yaml).toContain(line);
    });
  });
});
