import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { NotFoundError } from '../errors.js';
import { readLedgerRows } from '../decider/ledger.js';
import { isUnclaimed } from '../decider/search.js';
import { visibilityFor } from '../sessions/visibility.js';
import { getActiveRoot } from '../utils/paths.js';
import { citationOf } from './precedent-search.js';

const ArgsSchema = z.object({ key: z.string().min(1) });
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  key: z.string(),
  source: z.string(),
  asked_at: z.string().nullable(),
  initiative: z.string().nullable(),
  unclaimed: z.boolean(),
  category: z.string(),
  header: z.string().nullable(),
  question: z.string(),
  options: z.array(z.string()),
  recommended: z.string().nullable(),
  answer: z.string().nullable(),
  free_text: z.string().nullable(),
  answered_at: z.string().nullable(),
  outcome: z.string().nullable(),
  citation: z.string(),
});
type Result = z.infer<typeof ResultSchema>;

/** One message for every refusal, so a reply never shows that a withheld row exists. */
function notFound(key: string): NotFoundError {
  return new NotFoundError(`No precedent has key ${key}`);
}

export default defineCommand<Args, Result>({
  name: 'precedent.show',
  description: 'Open one precedent by its exact key, as cited by precedent.search.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: { positional: ['key'], usage: 'active-work precedent show <key>' },
  async run(args, ctx) {
    const activeRoot = getActiveRoot();
    const isVisible = await visibilityFor({ ...ctx, activeRoot });
    const { rows } = await readLedgerRows(activeRoot);
    const row = rows.find((candidate) => candidate.key === args.key);
    if (row === undefined || !isVisible(row.initiative)) throw notFound(args.key);
    const unclaimed = isUnclaimed(row);
    if (unclaimed && ctx.caller !== 'owner') throw notFound(args.key);
    return {
      key: row.key,
      source: row.source,
      asked_at: row.asked_at,
      initiative: row.initiative,
      unclaimed,
      category: row.category,
      header: row.header,
      question: row.question,
      options: row.options.map((o) => o.label),
      recommended: row.recommended,
      answer: row.answer,
      free_text: row.free_text,
      answered_at: row.answered_at,
      outcome: row.outcome,
      citation: citationOf(row),
    };
  },
});
