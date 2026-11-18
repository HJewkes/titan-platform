import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { NotFoundError, UsageError } from '../errors.js';
import { defineCommand, type CommandContext } from '../registry/index.js';
import { initiativeIsAgentVisible } from '../sessions/visibility.js';
import { getActiveRoot, getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { BACKFILL_FIELDS, backfillTask, findTaskFile, parseLabels, readTask, writeTask, type LabelRow } from './_task-backfill.js';

const ArgsSchema = z
  .object({
    from: z.string().min(1),
    dry_run: z.boolean().optional(),
    apply: z.boolean().optional(),
  })
  .strict();

type Args = z.infer<typeof ArgsSchema>;

const FieldCounts = z.record(z.string(), z.number());

const SummarySchema = z.object({
  mode: z.enum(['dry-run', 'apply']),
  rows: z.number(),
  unreadable_rows: z.number(),
  tasks_changed: z.number(),
  fields_written: FieldCounts,
  values_skipped: FieldCounts,
  missing_tasks: z.number(),
  owner_only_skipped: z.number(),
  initiatives: z.array(z.object({ slug: z.string(), tasks_changed: z.number(), fields_written: FieldCounts })),
  sample: z.array(z.string()),
});

type Summary = z.infer<typeof SummarySchema>;

const ResultSchema = z.union([SummarySchema, z.string()]);

const SAMPLE_SIZE = 10;

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

function emptySummary(mode: Summary['mode'], rows: number, unreadable: number): Summary {
  return {
    mode,
    rows,
    unreadable_rows: unreadable,
    tasks_changed: 0,
    fields_written: {},
    values_skipped: {},
    missing_tasks: 0,
    owner_only_skipped: 0,
    initiatives: [],
    sample: [],
  };
}

function groupBySlug(rows: Map<string, LabelRow>): Map<string, LabelRow[]> {
  const groups = new Map<string, LabelRow[]>();
  for (const row of rows.values()) {
    const slug = row.task.slice(0, row.task.indexOf('/'));
    groups.set(slug, [...(groups.get(slug) ?? []), row]);
  }
  return groups;
}

/** Plans (and, on apply, writes) one initiative's rows under its lock; returns the changed fields per task id. */
async function runInitiative(slug: string, rows: LabelRow[], apply: boolean, summary: Summary): Promise<void> {
  const root = getActiveRoot();
  const initiative = { slug, tasks_changed: 0, fields_written: {} as Record<string, number> };
  for (const row of rows) {
    const id = row.task.slice(slug.length + 1);
    const file = await findTaskFile(getInitiativeDir(slug), id);
    if (file === null) {
      summary.missing_tasks += 1;
      continue;
    }
    const { next, written, skipped } = await backfillTask(root, await readTask(file), row);
    for (const field of skipped) bump(summary.values_skipped, field);
    if (written.length === 0) continue;
    if (apply) await writeTask(file, next);
    for (const field of written) {
      bump(summary.fields_written, field);
      bump(initiative.fields_written, field);
    }
    initiative.tasks_changed += 1;
    summary.tasks_changed += 1;
    if (summary.sample.length < SAMPLE_SIZE) summary.sample.push(row.task);
  }
  if (initiative.tasks_changed > 0) summary.initiatives.push(initiative);
}

async function runAll(groups: Map<string, LabelRow[]>, apply: boolean, summary: Summary): Promise<void> {
  const root = getActiveRoot();
  for (const [slug, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (!(await initiativeIsAgentVisible(root, slug))) {
      summary.owner_only_skipped += rows.length;
      continue;
    }
    if (apply) await withFileLock(getLockPath(slug), () => runInitiative(slug, rows, true, summary));
    else await runInitiative(slug, rows, false, summary);
  }
}

const formatCounts = (counts: Record<string, number>): string =>
  BACKFILL_FIELDS.map((field) => `${field} ${counts[field] ?? 0}`).join('  ');

function renderText(summary: Summary): string {
  const verb = summary.mode === 'apply' ? 'changed' : 'would change';
  const lines = summary.initiatives.map(
    ({ slug, tasks_changed: n, fields_written: f }) => `${slug}  ${verb} ${n} tasks  ${formatCounts(f)}`,
  );
  lines.push(
    `total  ${verb} ${summary.tasks_changed} tasks  ${formatCounts(summary.fields_written)}`,
    `skipped values (not in the schema)  ${formatCounts(summary.values_skipped)}`,
    `rows ${summary.rows}  unreadable ${summary.unreadable_rows}  missing tasks ${summary.missing_tasks}  ` +
      `owner-only rows skipped ${summary.owner_only_skipped}`,
    `sample (${summary.sample.length})  ${summary.sample.join(' ')}`,
  );
  return `${lines.join('\n')}\n`;
}

async function readLabels(from: string, ctx: CommandContext): Promise<string> {
  try {
    return await fs.readFile(path.resolve(ctx.cwd ?? process.cwd(), from), 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') throw new NotFoundError(`Labels file not found: ${from}`);
    throw err;
  }
}

async function runBackfill(args: Args, ctx: CommandContext): Promise<Summary | string> {
  if ((args.dry_run === true) === (args.apply === true)) throw new UsageError('Pass exactly one of --dry-run or --apply');
  getActiveRoot();
  const { rows, unreadable } = parseLabels(await readLabels(args.from, ctx));
  const apply = args.apply === true;
  const summary = emptySummary(apply ? 'apply' : 'dry-run', rows.size, unreadable);
  await runAll(groupBySlug(rows), apply, summary);
  return ctx.format === 'json' ? summary : renderText(summary);
}

export default defineCommand<Args, z.infer<typeof ResultSchema>>({
  name: 'task.backfill-fields',
  description:
    'One-off migration (TP-5446 S10): fill empty class, serves, source, done_reason and blocked_on on existing tasks from an ' +
    'inferred-labels JSONL, each marked field_origin inferred:<heuristic id>. A recorded field is never overwritten, owner-only ' +
    'initiatives and missing tasks are skipped, and a value outside the schema is skipped and counted. Carve-out: unlike ' +
    '`task edit`, this may set class, source and serves on an already-dispatched task, but only while the field is empty and ' +
    'only with an inferred origin',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    usage: 'task backfill-fields --from <labels.jsonl> (--dry-run | --apply)',
    options: {
      from: { long: '--from', description: 'Labels JSONL: one row per task, <initiative>/<ID> with the labelled values' },
      dry_run: { long: '--dry-run', description: 'Report what would change; write nothing' },
      apply: { long: '--apply', description: 'Write the changes, through the validating writer under the initiative lock' },
    },
  },
  async run(args, ctx) {
    return runBackfill(args, ctx);
  },
});
