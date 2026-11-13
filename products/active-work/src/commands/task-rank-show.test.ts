import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../commands/index.js';
import { registry, type CommandContext } from '../registry/index.js';
import { TaskSchema } from '../schemas/task.js';
import { asTask } from '../test-support/as-task.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import taskAdd from './task-add.js';
import taskEdit from './task-edit.js';
import taskRankShow from './task-rank-show.js';

const SLUG = 'sample-initiative';

const ctx = (activeRoot: string): CommandContext => ({ activeRoot, warnings: [], format: 'json' });

/** Sets a rank the way the console's owner operation will: on the file, since no CLI or RPC verb does. */
async function rankOnDisk(root: string, id: string, rank: 'p0' | 'p1' | 'p2' | 'p3'): Promise<void> {
  const file = path.join(root, SLUG, 'tasks', `${id}.yml`);
  await writeYaml(file, { ...(await readYaml(file, TaskSchema)), rank }, TaskSchema);
}

function argKeys(schema: unknown): string[] {
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
}

describe('task rank show', () => {
  it('lists ranked open tasks p0 first, then by priority', async () => {
    await withTempActiveRoot(async (root) => {
      const ids: string[] = [];
      for (const priority of [3, 1, 2]) {
        ids.push(asTask(await taskAdd.run({ slug: SLUG, title: `Task ${priority}`, priority }, ctx(root))).id);
      }
      await rankOnDisk(root, ids[0]!, 'p1');
      await rankOnDisk(root, ids[1]!, 'p2');
      await rankOnDisk(root, ids[2]!, 'p1');

      const rows = await taskRankShow.run({ slug: SLUG }, ctx(root));
      const onlyP2 = await taskRankShow.run({ slug: SLUG, rank: 'p2' }, ctx(root));

      expect(rows.map((row) => row.id)).toEqual([ids[2], ids[0], ids[1]]);
      expect(onlyP2.map((row) => row.id)).toEqual([ids[1]]);
    });
  });

  it('no CLI or RPC path sets rank', async () => {
    await withTempActiveRoot(async (root) => {
      const rankArgs = registry
        .list()
        .filter((cmd) => cmd.name.startsWith('task.') && argKeys(cmd.args).includes('rank'))
        .map((cmd) => cmd.name);
      const added = asTask(await taskAdd.run({ slug: SLUG, title: 'Unranked' }, ctx(root)));

      const parsedAdd = taskAdd.args.safeParse({ slug: SLUG, title: 'Ranked', rank: 'p0' });

      expect(rankArgs).toEqual(['task.rank.show']);
      expect(parsedAdd.data).not.toHaveProperty('rank');
      const editRank = taskEdit.run({ slug: SLUG, id: added.id, field: 'rank', value: 'p0' }, ctx(root));
      await expect(editRank).rejects.toThrow('Field is not editable: rank');
    });
  });
});
