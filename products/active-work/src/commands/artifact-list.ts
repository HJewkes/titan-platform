import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ArtifactsSchema, type Artifacts } from '../schemas/artifacts.js';
import { getActiveRoot, getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml } from '../utils/yaml-io.js';
import { listInitiativeSlugsOrEmpty } from '../sessions/initiatives.js';
import { slugsForCaller } from '../sessions/visibility.js';
import { UsageError } from '../errors.js';
import { defineCommand, type CommandContext } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().optional(),
  all_initiatives: z.boolean().optional(),
});

const ItemSchema = z.object({
  slug: z.string(),
  artifacts: ArtifactsSchema,
});

const ResultSchema = z.object({
  items: z.array(ItemSchema),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

async function readForSlug(slug: string): Promise<Artifacts> {
  const artifactsPath = path.join(getInitiativeDir(slug), 'artifacts.yml');
  return withFileLock(getLockPath(slug), () => readYaml(artifactsPath, ArtifactsSchema));
}

async function listSlugsWithArtifacts(ctx: CommandContext): Promise<string[]> {
  const root = getActiveRoot();
  const slugs = await slugsForCaller(root, await listInitiativeSlugsOrEmpty(root), ctx);
  const present = await Promise.all(
    slugs.map((slug) =>
      fs.access(path.join(root, slug, 'artifacts.yml')).then(
        () => true,
        () => false,
      ),
    ),
  );
  return slugs.filter((_, i) => present[i]);
}

export default defineCommand<Args, Result>({
  name: 'artifact.list',
  description: 'List artifacts for a slug or across all initiatives.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      all_initiatives: {
        long: '--all-initiatives',
        description: 'Return artifacts for every initiative',
      },
    },
  },
  async run(args, ctx) {
    if (args.all_initiatives) {
      const slugs = await listSlugsWithArtifacts(ctx);
      const items: Array<{ slug: string; artifacts: Artifacts }> = [];
      for (const slug of slugs) {
        items.push({ slug, artifacts: await readForSlug(slug) });
      }
      return { items };
    }
    if (!args.slug) {
      throw new UsageError('artifact.list requires <slug> or --all-initiatives');
    }
    const artifacts = await readForSlug(args.slug);
    return { items: [{ slug: args.slug, artifacts }] };
  },
});
