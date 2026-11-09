import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import type { WorkerRecord } from '../schemas/worker-record.js';
import { NotFoundError } from '../errors.js';
import { defineCommand, type CommandContext } from '../registry/index.js';
import {
  ArgsSchema,
  NextStepsSchema,
  NotesSchema,
  ResolvesSchema,
  ResultSchema,
  TaskIdsSchema,
  parseFacts,
  parseLedger,
  requireAnswers,
  type Args,
  type Filed,
  type Ledger,
  type NoteInput,
  type Result,
} from './_wrap-args.js';
import {
  fileNotes,
  filesUpdated,
  rejectedResolves,
  rejectionReport,
  sweepAndRecord,
  verifyTaskIds,
  writeWrap,
} from './_wrap-write.js';

interface WrapInput {
  ledger: Ledger;
  notes: NoteInput[];
  taskIds: string[];
  worker: WorkerRecord | undefined;
  body: string;
}

async function assertInitiativeExists(briefPath: string, slug: string): Promise<void> {
  try {
    await fs.access(briefPath);
  } catch {
    throw new NotFoundError(`Initiative not found: ${slug}`);
  }
}

async function parseInput(args: Args): Promise<WrapInput> {
  const ledger: Ledger = {
    next_steps: parseLedger(args.next_steps, NextStepsSchema, 'next-steps'),
    resolves: parseLedger(args.resolves, ResolvesSchema, 'resolves'),
  };
  const notes = parseLedger(args.notes, NotesSchema, 'notes');
  const taskIds = parseLedger(args.tasks_filed, TaskIdsSchema, 'tasks-filed');
  const worker = parseFacts(args.facts);
  requireAnswers(args, ledger, notes, taskIds);
  const body = args.body ?? (await fs.readFile(args.body_file!, 'utf8'));
  return { ledger, notes, taskIds, worker, body };
}

interface WrapPaths extends WrapInput {
  initiativeDir: string;
  briefPath: string;
}

/** Files the wrap wrote, and what the git sweep recorded; unwound together on failure. */
async function fileNotesAndSweep(
  args: Args,
  ctx: CommandContext,
  paths: WrapPaths,
  written: { path: string; updated: string },
): Promise<{ notePaths: string[]; recorded: Pick<Filed, 'worktrees' | 'branches' | 'stashes'> }> {
  const notePaths: string[] = [];
  try {
    notePaths.push(...(await fileNotes(paths.initiativeDir, paths.notes, written.updated)));
    const recorded = await sweepAndRecord(args.slug, ctx.activeRoot, ctx.warnings);
    return { notePaths, recorded };
  } catch (err) {
    await Promise.all([...notePaths, written.path].map((p) => fs.rm(p, { force: true })));
    throw err;
  }
}

async function wrapLocked(args: Args, ctx: CommandContext, paths: WrapPaths): Promise<Result> {
  const { initiativeDir, ledger, taskIds } = paths;
  await verifyTaskIds(initiativeDir, taskIds);
  const written = await writeWrap(args, paths.briefPath, paths.body, ledger, paths.worker);
  const { notePaths, recorded } = await fileNotesAndSweep(args, ctx, paths, written);
  const total = ledger.resolves.length;
  const rejected = await rejectedResolves(initiativeDir, written.filename);
  const filed: Filed = {
    next_steps: ledger.next_steps.length,
    notes: notePaths.length,
    tasks: taskIds.length,
    ...recorded,
  };
  if (rejected.length > 0) {
    ctx.warnings.push(rejectionReport(written.path, rejected, total));
  }
  return {
    path: written.path,
    filename: written.filename,
    ready_to_end: rejected.length === 0,
    filed,
    closed: { resolves_applied: total - rejected.length },
    resolves_rejected: rejected,
    updated: written.updated,
    files_updated: filesUpdated(initiativeDir, notePaths, filed),
  };
}

export default defineCommand<Args, Result>({
  name: 'wrap',
  description:
    'The last thing a session does. Treat it as the moment the process exits: everything ' +
    'not persisted before wrap returns is lost, so file it first and wrap last. Every ' +
    'category the session can leave behind needs an explicit answer, and omitting one is ' +
    'an error rather than a default — open loops (--next-steps / --resolves, or --no-loops), ' +
    'durable notes (--notes or --no-notes), and tasks created this session (--tasks-filed or ' +
    '--no-tasks). Writes the session file and its ledger, files the notes under ' +
    'sources/notes/, records any worktrees, branches and stashes the initiative had not ' +
    "written down, stamps the brief's updated date, and returns a receipt of what was filed.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      session_id: {
        long: '--session-id',
        description: 'Claude session identifier',
        required: true,
      },
      started: {
        long: '--started',
        description: 'ISO 8601 session start timestamp',
        required: true,
      },
      ended: {
        long: '--ended',
        description: 'ISO 8601 session end timestamp',
        required: true,
      },
      track: {
        long: '--track',
        description:
          "'canonical' (mainline thread) | 'sidecar' (folded/derived) | 'adhoc' (parallel ad-hoc work) (default: canonical)",
      },
      parent_session_id: {
        long: '--parent-session',
        description:
          'Session id that spawned this one. Set by the agent-chat spawn hook for peers, whose parentage no transcript records.',
      },
      body: {
        long: '--body',
        description: 'Raw markdown body (session narrative)',
      },
      body_file: {
        long: '--body-file',
        description: 'Path to a file containing the markdown body',
      },
      next_steps: {
        long: '--next-steps',
        description:
          'JSON array of loops this session opens: [{"id","text","kind":"task|pr|prose","ref"?,"due"?}]',
      },
      resolves: {
        long: '--resolves',
        description:
          'JSON array of loops this session closes: [{"ref":"<session-file-stem>#<id>","outcome":"done|abandoned","note"?}]',
      },
      no_loops: {
        long: '--no-loops',
        description:
          'Assert that this session leaves nothing hanging. Records no_loops: true so a deliberate empty ledger is distinguishable from an unfiled one. Mutually exclusive with --next-steps / --resolves.',
      },
      notes: {
        long: '--notes',
        description:
          'JSON array of durable notes to file under sources/notes/: [{"kind":"process|gotcha|fyi|decision","title","body","tags"?}]',
      },
      no_notes: {
        long: '--no-notes',
        description:
          'Assert that this session produced no durable knowledge worth keeping. Mutually exclusive with --notes.',
      },
      tasks_filed: {
        long: '--tasks-filed',
        description:
          'JSON array of task ids created during this session, e.g. ["AW-66","AW-67"]. Each must already exist in the initiative.',
      },
      no_tasks: {
        long: '--no-tasks',
        description:
          'Assert that this session filed no tasks. Mutually exclusive with --tasks-filed.',
      },
      facts: {
        long: '--facts',
        description:
          'JSON object recording a spawned worker; stamps kind: worker and stores it as the worker block: ' +
          '{"facts":<WorkerFacts from @titan-design/agent-protocol/worker-facts>,"resolves"?:["<task id>"],' +
          '"outcome"?:"exited-no-report","last_action"?,"authored"?:{"continuations"?,"open_questions"?,"next_why"?}}. ' +
          'outcome is required exactly when facts.report is absent; authored is optional and capped at 1,500 characters.',
      },
    },
    usage:
      'active-work wrap <slug> --session-id <id> --started <iso> --ended <iso> [--track canonical|sidecar|adhoc] (--body <text> | --body-file <path>) (--next-steps <json> | --resolves <json> | --no-loops) (--notes <json> | --no-notes) (--tasks-filed <json> | --no-tasks) [--facts <json>]',
  },
  async run(args, ctx) {
    const initiativeDir = path.join(ctx.activeRoot, args.slug);
    const briefPath = path.join(initiativeDir, 'brief.md');
    await assertInitiativeExists(briefPath, args.slug);
    const input = await parseInput(args);
    return withFileLock(getLockPath(args.slug), () =>
      wrapLocked(args, ctx, { initiativeDir, briefPath, ...input }),
    );
  },
});
