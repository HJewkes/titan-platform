import { z } from 'zod';
import { UsageError } from '../errors.js';
import { TIERS } from '../schemas/loop-ledger.js';
import { resolveLedgerPaths, setLoopTier, type TierResult } from '../sessions/ledger-file.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  id: z.string().min(1),
  tier: z.enum([...TIERS, 'unsorted']),
  before: z.string().min(1).optional(),
});

const ResultSchema = z.object({
  id: z.string(),
  tier: z.enum(TIERS).nullable(),
  tier_rank: z.number().nullable(),
  tier_set: z.object({ at: z.string(), by: z.literal('owner') }),
});

type Args = z.infer<typeof ArgsSchema>;

export default defineCommand<Args, TierResult>({
  name: 'loop.tier',
  description:
    'Re-tier one ledger loop: writes its tier, its rank within the tier and tier_set ' +
    '{at, by: owner}, and leaves every other row as it was. --before <id> places it ahead of ' +
    'that loop in the same tier; otherwise it goes last. `unsorted` clears the tier.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['id', 'tier'],
    options: {
      before: {
        long: '--before',
        description: 'Place the loop ahead of this loop id in the same tier',
      },
    },
    usage: 'active-work loop tier <id> <S|A|B|C|parked|unsorted> [--before <id>]',
  },
  async run(args, ctx) {
    const tier = args.tier === 'unsorted' ? null : args.tier;
    if (tier === null && args.before !== undefined) {
      throw new UsageError('--before orders a loop within a tier; unsorted has no order');
    }
    const paths = await resolveLedgerPaths(ctx.activeRoot);
    return setLoopTier(paths, { id: args.id, tier, before: args.before, now: new Date() });
  },
});
