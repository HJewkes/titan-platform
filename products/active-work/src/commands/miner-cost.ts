import { readFile } from 'node:fs/promises';
import {
  costReport,
  costReportSchema,
  renderCostReportText,
} from '@titan-design/session-analytics';
import { EXTRACT_VERSION } from '@titan-design/session-read';
import { z } from 'zod';
import { UsageError } from '../errors.js';
import { defineCommand } from '../registry/index.js';
import { defaultGraphPath, openGraphReadOnly } from '../session-index/graph.js';

/**
 * `active-work miner cost` — spend over the session-signal index, sliced by
 * class, role, initiative, context band, wake cause, and cold-rebuild cost.
 *
 * The report itself lives in `@titan-design/session-analytics`; this command
 * only wires the window/top args and the read-only graph open onto it.
 */

const ArgsSchema = z.object({
  days: z.coerce.number().int().positive().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  top: z.coerce.number().int().positive().optional(),
  session_ids: z.array(z.string().min(1)).optional(),
});
type Args = z.infer<typeof ArgsSchema>;

/** An `@<file>` value stands for the ids on its lines; any other value is one id. */
async function expandSessionIds(values: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const value of values) {
    if (!value.startsWith('@')) {
      ids.push(value);
      continue;
    }
    const text = await readFile(value.slice(1), 'utf8');
    const fileIds = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (fileIds.length === 0) {
      throw new UsageError(`--session-ids file ${value.slice(1)} has no session ids`);
    }
    ids.push(...fileIds);
  }
  return ids;
}

const ResultSchema = costReportSchema;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'miner.cost',
  description:
    'Report session-signal spend by class, role, initiative, context band, wake cause, and cold-rebuild cost.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      days: {
        long: '--days',
        description: 'Window length in days, ending now (or --until). Overridden by --since.',
      },
      since: {
        long: '--since',
        description: 'ISO timestamp or date, inclusive. Overrides --days.',
      },
      until: { long: '--until', description: 'ISO timestamp or date, exclusive.' },
      top: { long: '--top', description: 'Sessions listed in topSessions (default 10).' },
      session_ids: {
        long: '--session-ids',
        description:
          'Limit the report to a session id. Repeat the flag for each value, or pass @<file> with one id per line. A file with no ids is a usage error.',
      },
    },
  },
  async run(args, ctx) {
    const sessionIds = args.session_ids && (await expandSessionIds(args.session_ids));
    const db = openGraphReadOnly(defaultGraphPath());
    try {
      const report = costReport(db, {
        days: args.days,
        since: args.since,
        until: args.until,
        top: args.top,
        ...(sessionIds ? { scope: { sessionIds } } : {}),
        facetVersion: EXTRACT_VERSION,
      });
      if (ctx.format !== 'json') process.stderr.write(renderCostReportText(report));
      return report;
    } finally {
      db.close();
    }
  },
});
