import { z } from 'zod';
import { listSlugsForCaller, wireVisibility } from '../sessions/visibility.js';
import { getActiveRoot } from '../utils/paths.js';
import { inventoryCache } from '../workspace-index/inventory-cache.js';
import { summarizeInventory, totalInventory } from '../workspace-index/inventory-summary.js';
import { WIRE_CLASSES, type WireClass } from '../workspace-index/wire.js';
import { defineCommand } from '../registry/index.js';
import { humanOnlyPredicate } from './_list-scope.js';

const ArgsSchema = z.object({}).strict();

const StatSchema = z.object({
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  newest_mtime: z.string().nullable(),
});

const ClassesSchema = z.object(
  Object.fromEntries(WIRE_CLASSES.map((cls) => [cls, StatSchema])) as Record<
    WireClass,
    typeof StatSchema
  >,
);

const InitiativeSchema = z.object({
  slug: z.string(),
  human_only: z.boolean(),
  // The full verdict, brief and charter together (TP-5556): true when agents may not read it,
  // and true for every row when the charter is unreadable. Readers treat a missing field as true.
  withheld_from_agents: z.boolean(),
  total: StatSchema,
  classes: ClassesSchema,
  nested_dirs: z.array(StatSchema.extend({ dir: z.string() })),
});

const ResultSchema = z.object({
  initiatives: z.array(InitiativeSchema),
  totals: z.object({ total: StatSchema, classes: ClassesSchema }),
  // False when the charter is unreadable; every initiative is then flagged human_only.
  human_only_known: z.boolean(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'inventory',
  description:
    'What is where under the active root: file count, bytes and newest mtime per initiative and record class, with nested sources (unindexed files under sources/<dir>/) counted separately. Classes: initiatives, tasks, sessions, notes, sources, nested_sources, and other, which holds every remaining visible file under the initiative (handoff, snapshots, artifacts, non-markdown sources); dot-files are excluded.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: { usage: 'active-work inventory [--json]' },
  async run(_args, ctx) {
    const activeRoot = getActiveRoot();
    const [slugs, files, humanOnly] = await Promise.all([
      listSlugsForCaller(activeRoot, ctx),
      inventoryCache.scan(activeRoot),
      humanOnlyPredicate(activeRoot, ctx.warnings),
    ]);
    const wire = await wireVisibility(activeRoot, slugs);
    const initiatives = summarizeInventory(slugs, files, humanOnly.isHumanOnly).map((row) => ({
      ...row,
      withheld_from_agents: wire.get(row.slug)?.withheld_from_agents ?? true,
    }));
    return {
      initiatives,
      totals: totalInventory(initiatives),
      human_only_known: humanOnly.known,
    };
  },
});
