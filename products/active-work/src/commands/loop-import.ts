import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { TierSeedSchema, type TierSeed } from '../schemas/loop-ledger.js';
import { importLedger, resolveLedgerPaths } from '../sessions/ledger-file.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  snapshot: z.string().min(1),
  tree: z.string().min(1).optional(),
  tiers: z.string().min(1).optional(),
});

const ResultSchema = z.object({
  ledger: z.string(),
  tree: z.string().nullable(),
  added: z.number().int(),
  updated: z.number().int(),
  seeded: z.number().int(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

async function readSeed(file: string): Promise<TierSeed> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    throw new ValidationError(`Could not read the tier seed ${file}: ${(err as Error).message}`);
  }
  const seed = TierSeedSchema.safeParse(parsed);
  if (!seed.success) throw new ValidationError(`Tier seed ${file}: ${seed.error.message}`);
  return seed.data;
}

export default defineCommand<Args, Result>({
  name: 'loop.import',
  description:
    'Upsert a sweep snapshot into the open-loops ledger by loop id. A loop keeps any tier ' +
    'already set, so a later sweep never undoes an owner move. --tiers seeds untiered loops ' +
    'from the tier JSON ({"S": [ids], "A": [...], ..., "Parked": [...]}) as a proposal; ids ' +
    'it does not name stay Unsorted. --tree replaces the tech tree file.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['snapshot'],
    options: {
      tree: { long: '--tree', description: 'Tech tree yml to install beside the ledger' },
      tiers: { long: '--tiers', description: 'Tier seed JSON, applied to untiered loops' },
    },
    usage: 'active-work loop import <snapshot.yml> [--tree <tree.yml>] [--tiers <tiers.json>]',
  },
  async run(args, ctx) {
    const cwd = ctx.cwd ?? process.cwd();
    const resolve = (file: string): string => path.resolve(cwd, file);
    const [snapshotText, treeText, seed] = await Promise.all([
      fs.readFile(resolve(args.snapshot), 'utf8'),
      args.tree === undefined ? undefined : fs.readFile(resolve(args.tree), 'utf8'),
      args.tiers === undefined ? undefined : readSeed(resolve(args.tiers)),
    ]);
    const paths = await resolveLedgerPaths(ctx.activeRoot);
    const { warnings, ...result } = await importLedger(paths, {
      snapshotText,
      treeText,
      seed,
      now: new Date(),
    });
    ctx.warnings.push(...warnings);
    return result;
  },
});
