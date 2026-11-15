import { readTaskInitiative, taskLedger, type LedgerRow } from '@titan-design/session-analytics';
import { z } from 'zod';
import { UsageError } from '../errors.js';
import { defineCommand } from '../registry/index.js';
import { defaultGraphPath, openGraphReadOnly } from '../session-index/graph.js';
import { visibilityFor } from '../sessions/visibility.js';

/**
 * `active-work miner ledger <task>`: every session that worked a task, with what it cost, the PRs it
 * linked and the review verdicts on them (TP-6311).
 */

const ArgsSchema = z.object({ task: z.string().min(1) });
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  task: z.string(),
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      agentName: z.string().nullable(),
      profile: z.string().nullable(),
      startedAt: z.string().nullable(),
      endedAt: z.string().nullable(),
      usd: z.number(),
      unpriced: z.boolean(),
      prs: z.array(z.object({ prRef: z.string(), state: z.string().nullable(), mergedAt: z.string().nullable() })),
      verdicts: z.array(z.object({ prRef: z.string(), verdict: z.string(), ts: z.string() })),
    }),
  ),
});
type Result = z.infer<typeof ResultSchema>;

const DASH = '-';

function renderRow(row: LedgerRow): string {
  const who = [row.agentName ?? DASH, row.profile ?? DASH].join(' / ');
  const span = `${row.startedAt ?? DASH} .. ${row.endedAt ?? DASH}`;
  const cost = `$${row.usd.toFixed(2)}${row.unpriced ? ' (unpriced model: undercounted)' : ''}`;
  const prs = row.prs.map((pr) => `${pr.prRef} ${pr.state ?? DASH}${pr.mergedAt ? ` merged ${pr.mergedAt}` : ''}`);
  const verdicts = row.verdicts.map((v) => `${v.prRef} ${v.verdict} ${v.ts}`);
  const lines = [`${row.sessionId}  ${who}  ${span}  ${cost}`];
  if (prs.length > 0) lines.push(`  PRs: ${prs.join('; ')}`);
  if (verdicts.length > 0) lines.push(`  Verdicts: ${verdicts.join('; ')}`);
  return lines.join('\n');
}

function renderLedger(task: string, rows: readonly LedgerRow[]): string {
  if (rows.length === 0) return `No sessions are linked to ${task}.\n`;
  return `${task}: ${rows.length} session${rows.length === 1 ? '' : 's'}, newest first\n${rows.map(renderRow).join('\n')}\n`;
}

export default defineCommand<Args, Result>({
  name: 'miner.ledger',
  description: 'List the prior sessions on a task with cost, linked PRs and review verdicts.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: { positional: ['task'], usage: 'active-work miner ledger <task>' },
  async run(args, ctx) {
    const db = openGraphReadOnly(defaultGraphPath());
    try {
      const sessions = taskLedger(db, args.task);
      const initiative = readTaskInitiative(db, args.task);
      const shown = await visibilityFor(ctx);
      if ((initiative !== null || sessions.length > 0) && !shown(initiative)) {
        throw new UsageError(`the ledger for ${args.task} is owner-only`);
      }
      if (ctx.format !== 'json') process.stderr.write(renderLedger(args.task, sessions));
      return { task: args.task, sessions };
    } finally {
      db.close();
    }
  },
});
