import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { rebuildGraph } from '../session-index/rebuild.js';
import { describeLockWait } from './miner-refresh.js';

/**
 * `active-work miner rebuild` — index the corpus into a fresh graph file and
 * swap it in for the live one, keeping the old file as a backup (TP-882).
 *
 * Unlike `miner refresh --full` it never resets the live file and holds the
 * refresh lock only to seed the new file and to swap. The daemon keeps serving
 * the old file meanwhile, and reopens the new one on its next pass.
 */

const ArgsSchema = z.object({
  resume: z.boolean().optional(),
  force: z.boolean().optional(),
});
type Args = z.infer<typeof ArgsSchema>;

const TotalsSchema = z.object({
  turns: z.number(),
  turnDurationMs: z.number(),
  toolCalls: z.number(),
  requests: z.number(),
  requestCount: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

const ResultSchema = z.object({
  nextPath: z.string(),
  backupPath: z.string().nullable(),
  swapped: z.boolean(),
  preserved: z.number(),
  carried: z.record(z.string(), z.number()),
  passes: z.number(),
  liveTotals: TotalsSchema,
  nextTotals: TotalsSchema,
  inode: z.string().nullable(),
  errors: z.array(z.string()),
});
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'miner.rebuild',
  description:
    'Rebuild the session-signal index into a fresh file and swap it in, keeping the old file as a backup.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      resume: {
        long: '--resume',
        description: 'Continue the graph.sqlite3.next a stopped rebuild left behind.',
      },
      force: {
        long: '--force',
        description: 'Swap even when turn or request totals differ from the live file.',
      },
    },
  },
  async run(args) {
    return rebuildGraph({
      resume: args.resume,
      force: args.force,
      lock: {
        onWait: (holder) => process.stderr.write(describeLockWait(holder, 'miner rebuild')),
      },
    });
  },
});
