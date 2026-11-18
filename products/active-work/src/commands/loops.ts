import path from 'node:path';
import { z } from 'zod';
import {
  deriveOpenLoopsFrom,
  deriveResolvedLoopsFrom,
  loadSessionsFromDir,
  triggersMet,
  type LoadedSessions,
  type LoopTrigger,
  type OpenLoop,
} from '../sessions/open-loops.js';
import { findMergedPrLoops } from '../sessions/loop-pr-state.js';
import { resolveLedgerPaths } from '../sessions/ledger-file.js';
import { LoopSourceSchema, readLedgerLoops, sessionSourceOf } from '../session-index/loop-board.js';
import type { LedgerLoop } from '../schemas/loop-ledger.js';
import { loadTasks } from '../bootstrap/load.js';
import type { Task } from '../schemas/task.js';
import { assertValidSlug } from '../utils/slug.js';
import { defineCommand, type CommandContext } from '../registry/index.js';
import { UsageError } from '../errors.js';
import { listSlugsForCaller } from '../sessions/visibility.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ArgsSchema = z.object({
  slug: z.string().min(1).optional(),
  all_initiatives: z.boolean().optional(),
  state: z.enum(['open', 'resolved', 'abandoned', 'all']).default('open'),
  due: z.boolean().optional(),
  offline: z.boolean().optional(),
});

const OpenLoopSchema = z.object({
  ref: z.string(),
  text: z.string(),
  kind: z.enum(['task', 'pr', 'prose']),
  target_ref: z.string().optional(),
  due: z.string().optional(),
  /** Present when the loop is owed now: which of its triggers fired. */
  trigger_met: z.array(z.enum(['task-done', 'pr-merged', 'due'])).optional(),
  /** A ledger row's file, relative to the ledger's initiative, or the session file stem. */
  session_file: z.string(),
  opened_at: z.string(),
  age_days: z.number().int().nonnegative(),
  source: LoopSourceSchema,
  /** Set only by --all-initiatives, where the entry's initiative is otherwise lost. */
  slug: z.string().optional(),
});

const ResolvedLoopSchema = z.object({
  ref: z.string(),
  text: z.string(),
  kind: z.enum(['task', 'pr', 'prose']),
  outcome: z.enum(['done', 'abandoned']),
  note: z.string().optional(),
  session_file: z.string(),
  closed_by: z.string(),
  opened_at: z.string(),
  closed_at: z.string(),
  age_days: z.number().int().nonnegative(),
  slug: z.string().optional(),
});

const ResultSchema = z.object({
  /** Absent for --all-initiatives, whose entries carry their own slug. */
  slug: z.string().optional(),
  open: z.array(OpenLoopSchema),
  resolved: z.array(ResolvedLoopSchema),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

type OpenEntry = z.infer<typeof OpenLoopSchema>;
type ResolvedEntry = z.infer<typeof ResolvedLoopSchema>;

interface OpenContext {
  initiativeDir: string;
  tasks: Task[];
  now: Date;
  warnings: string[];
}

function toOpenEntry(loop: OpenLoop, fired: LoopTrigger[]): OpenEntry {
  return {
    ref: loop.ref,
    text: loop.text,
    kind: loop.kind,
    ...(loop.targetRef !== undefined ? { target_ref: loop.targetRef } : {}),
    ...(loop.due !== undefined ? { due: loop.due } : {}),
    ...(fired.length > 0 ? { trigger_met: fired } : {}),
    session_file: loop.sessionFile,
    opened_at: loop.openedAt,
    age_days: loop.ageDays,
    source: sessionSourceOf(loop),
  };
}

function ledgerEntry(row: LedgerLoop, file: string, fallbackDate: string, now: Date): OpenEntry {
  const openedAt = row.first_raised ?? row.last_motion?.date ?? fallbackDate;
  const ms = new Date(openedAt).getTime();
  return {
    ref: row.id,
    text: row.title,
    kind: 'prose',
    session_file: file,
    opened_at: openedAt,
    age_days: Number.isNaN(ms) ? 0 : Math.max(0, Math.floor((now.getTime() - ms) / MS_PER_DAY)),
    source: 'ledger',
  };
}

/** The platform ledger's open rows for this initiative; a missing ledger has none. */
async function ledgerEntries(slug: string, context: OpenContext & { activeRoot: string }) {
  const paths = await resolveLedgerPaths(context.activeRoot);
  const { rows, mtime, warnings } = await readLedgerLoops(paths);
  context.warnings.push(...warnings);
  const file = path.relative(path.join(context.activeRoot, paths.initiative), paths.loopsPath);
  return rows
    .filter((row) => row.initiative === slug && row.status !== 'DONE')
    .map((row) => ledgerEntry(row, file, mtime ?? context.now.toISOString(), context.now));
}

/**
 * Every loop with no explicit resolution, marked with the triggers that fired.
 *
 * Derived without `tasks`, unlike the bootstrap: there a done task closes its
 * loop silently, which is right for "finish SI-1" and wrong for "once SI-1 is
 * done, do X". Here such a loop stays listed and says its trigger is met.
 */
async function openEntries(
  loaded: LoadedSessions,
  args: Args,
  context: OpenContext,
): Promise<OpenEntry[]> {
  const { now, tasks } = context;
  const loops = deriveOpenLoopsFrom(loaded, { now });
  const prs =
    args.offline === true
      ? { merged: new Set<string>(), warnings: [] }
      : await findMergedPrLoops(context.initiativeDir, loops);
  context.warnings.push(...prs.warnings);
  return loops.map((loop) => {
    const mergedPrs = prs.merged.has(loop.ref) && loop.targetRef ? [loop.targetRef] : [];
    return toOpenEntry(loop, triggersMet(loop, { now, tasks, mergedPrs }));
  });
}

function resolvedEntries(loaded: LoadedSessions, args: Args, context: OpenContext) {
  return deriveResolvedLoopsFrom(loaded, context)
    .filter((loop) => args.state !== 'abandoned' || loop.outcome === 'abandoned')
    .map((loop) => ({
      ref: loop.ref,
      text: loop.text,
      kind: loop.kind,
      outcome: loop.outcome,
      ...(loop.note !== undefined ? { note: loop.note } : {}),
      session_file: loop.sessionFile,
      closed_by: loop.closedBy,
      opened_at: loop.openedAt,
      closed_at: loop.closedAt,
      age_days: loop.ageDays,
    }));
}

export default defineCommand<Args, Result>({
  name: 'loops',
  description:
    "List an initiative's open-loop ledger. Open loops are the unresolved remainder; a loop " +
    'whose referenced task is done, whose referenced PR is merged or whose due time has passed ' +
    'carries trigger_met, and --due lists only those. Resolved ones carry the outcome and the ' +
    'reason they were closed, which the bootstrap only surfaces for recent abandonments. Open ' +
    'and close loops between wraps with `loop open` and `loop resolve`.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      all_initiatives: {
        long: '--all-initiatives',
        description: 'List loops across every initiative visible to the caller, in place of a slug',
      },
      state: {
        long: '--state',
        description: "'open' (default) | 'resolved' | 'abandoned' | 'all'",
      },
      due: {
        long: '--due',
        description:
          'Only open loops whose trigger is met: due time passed, task done or PR merged. Overrides --state',
      },
      offline: {
        long: '--offline',
        description: 'Skip the GitHub check for merged PRs; pr loops are then never marked',
      },
    },
    usage:
      'active-work loops (<slug> | --all-initiatives) [--state open|resolved|abandoned|all] [--due] [--offline]',
  },
  async run(args, ctx) {
    if (args.all_initiatives === true) return runAcrossInitiatives(args, ctx);
    if (args.slug === undefined) {
      throw new UsageError('loops requires a slug or --all-initiatives');
    }
    return runForSlug(args.slug, args, ctx);
  },
});

async function runAcrossInitiatives(args: Args, ctx: CommandContext): Promise<Result> {
  if (args.slug !== undefined) {
    throw new UsageError('loops takes a slug or --all-initiatives, not both');
  }
  const slugs = await listSlugsForCaller(ctx.activeRoot, ctx);
  const open: OpenEntry[] = [];
  const resolved: ResolvedEntry[] = [];
  for (const slug of slugs) {
    const one = await runForSlug(slug, args, ctx);
    open.push(...one.open.map((loop) => ({ ...loop, slug })));
    resolved.push(...one.resolved.map((loop) => ({ ...loop, slug })));
  }
  return { open, resolved };
}

async function runForSlug(slug: string, args: Args, ctx: CommandContext): Promise<Result> {
  assertValidSlug(slug);
  const initiativeDir = path.join(ctx.activeRoot, slug);
  const [loaded, { tasks }] = await Promise.all([
    loadSessionsFromDir(initiativeDir),
    loadTasks(initiativeDir, { archive: true }),
  ]);
  const context = {
    initiativeDir,
    activeRoot: ctx.activeRoot,
    tasks,
    now: new Date(),
    warnings: ctx.warnings,
  };
  const dueOnly = args.due === true;
  const wantOpen = dueOnly || args.state === 'open' || args.state === 'all';
  const wantResolved = !dueOnly && args.state !== 'open';

  const open = wantOpen
    ? [...(await openEntries(loaded, args, context)), ...(await ledgerEntries(slug, context))]
    : [];
  return {
    slug,
    open: dueOnly ? open.filter((loop) => loop.trigger_met !== undefined) : open,
    resolved: wantResolved ? resolvedEntries(loaded, args, context) : [],
  };
}
