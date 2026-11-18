import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { wireVisibility } from '../sessions/visibility.js';
import { getActiveRoot } from '../utils/paths.js';
import { scanInitiativesForCaller } from './audit.js';

const TASK_FILE = /^([A-Z][A-Z0-9]*-\d+)\.yml$/;

const ArgsSchema = z.object({}).strict();

const InitiativeKeysSchema = z.object({
  slug: z.string(),
  task_prefix: z.string(),
  withheld_from_agents: z.boolean(),
  /** Every task file's id, open or archived: a key names a task if its file exists. */
  ids: z.array(z.string()),
});

const ResultSchema = z.object({ initiatives: z.array(InitiativeKeysSchema) });

type Result = z.infer<typeof ResultSchema>;

async function idsIn(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).flatMap((file) => TASK_FILE.exec(file)?.[1] ?? []);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function taskIds(activeRoot: string, slug: string): Promise<string[]> {
  const tasks = path.join(activeRoot, slug, 'tasks');
  const [open, archived] = await Promise.all([idsIn(tasks), idsIn(path.join(tasks, 'archive'))]);
  return [...new Set([...open, ...archived])].sort();
}

export default defineCommand<z.infer<typeof ArgsSchema>, Result>({
  name: 'task.keys',
  description:
    "Every initiative's task prefix, withheld-from-agents verdict and task ids (open and archived), read from file names: the index a task key resolves against",
  args: ArgsSchema,
  result: ResultSchema,
  cli: { usage: 'task keys' },
  async run(_args, ctx) {
    const activeRoot = getActiveRoot();
    const { entries } = await scanInitiativesForCaller(activeRoot, ctx);
    const wire = await wireVisibility(
      activeRoot,
      entries.map((entry) => entry.slug),
    );
    const initiatives = await Promise.all(
      entries.map(async ({ slug, frontmatter }) => ({
        slug,
        task_prefix: frontmatter.task_prefix,
        withheld_from_agents: wire.get(slug)?.withheld_from_agents ?? true,
        ids: await taskIds(activeRoot, slug),
      })),
    );
    return { initiatives };
  },
});
