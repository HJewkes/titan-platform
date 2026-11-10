import { z } from 'zod';
import { NoteKindSchema } from '../schemas/note.js';
import { WorkerRecordSchema, type WorkerRecord } from '../schemas/worker-record.js';
import {
  SessionIdSchema,
  NextStepSchema,
  SessionResolveSchema,
  type NextStep,
  type SessionResolve,
} from '../schemas/session.js';
import { ValidationError } from '../errors.js';

export const NextStepsSchema = z.array(NextStepSchema);
export const ResolvesSchema = z.array(SessionResolveSchema);

const NoteInputSchema = z.object({
  kind: NoteKindSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(z.string().min(1)).optional(),
});
export const NotesSchema = z.array(NoteInputSchema);
export const TaskIdsSchema = z.array(z.string().min(1));

// MCP callers pass structured arrays; the CLI passes a JSON string through a
// single flag, since comma-splitting cannot express nested objects.
const nextStepsArg = z.union([z.string(), NextStepsSchema]);
const resolvesArg = z.union([z.string(), ResolvesSchema]);
const notesArg = z.union([z.string(), NotesSchema]);
const taskIdsArg = z.union([z.string(), TaskIdsSchema]);
const factsArg = z.union([z.string(), WorkerRecordSchema]);

export const ArgsSchema = z
  .object({
    slug: z.string().min(1),
    session_id: SessionIdSchema,
    started: z.string().min(1),
    ended: z.string().min(1),
    track: z.enum(['canonical', 'sidecar', 'adhoc']).default('canonical'),
    parent_session_id: SessionIdSchema.optional(),
    body: z.string().optional(),
    body_file: z.string().optional(),
    next_steps: nextStepsArg.optional(),
    resolves: resolvesArg.optional(),
    no_loops: z.boolean().optional(),
    notes: notesArg.optional(),
    no_notes: z.boolean().optional(),
    tasks_filed: taskIdsArg.optional(),
    no_tasks: z.boolean().optional(),
    facts: factsArg.optional(),
  })
  .superRefine((value, ctx) => {
    const hasBody = value.body !== undefined;
    const hasFile = value.body_file !== undefined;
    if (!hasBody && !hasFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'Exactly one of --body or --body-file is required',
      });
    }
    if (hasBody && hasFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: '--body and --body-file are mutually exclusive',
      });
    }
  });

const RejectedResolveSchema = z.object({
  ref: z.string(),
  kind: z.enum(['missing', 'not-prior', 'self']),
});

const FiledSchema = z.object({
  next_steps: z.number().int().nonnegative(),
  notes: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  worktrees: z.number().int().nonnegative(),
  branches: z.number().int().nonnegative(),
  stashes: z.number().int().nonnegative(),
});

export const ResultSchema = z.object({
  path: z.string(),
  filename: z.string(),
  /** False only when some `resolves` ref closed nothing and must be re-filed. */
  ready_to_end: z.boolean(),
  filed: FiledSchema,
  // Not `resolves`: the count of refs passed says nothing about how many closed
  // a loop, and the caller acts on the difference.
  closed: z.object({ resolves_applied: z.number().int().nonnegative() }),
  resolves_rejected: z.array(RejectedResolveSchema),
  /** The date stamped into `brief.updated`. */
  updated: z.string(),
  /** Files this wrap touched, relative to the initiative directory. */
  files_updated: z.array(z.string()),
});

export type Args = z.infer<typeof ArgsSchema>;
export type Result = z.infer<typeof ResultSchema>;
export type RejectedResolve = z.infer<typeof RejectedResolveSchema>;
export type NoteInput = z.infer<typeof NoteInputSchema>;
export type Filed = z.infer<typeof FiledSchema>;

export interface Ledger {
  next_steps: NextStep[];
  resolves: SessionResolve[];
}

export function parseLedger<T>(
  raw: string | T[] | undefined,
  schema: z.ZodType<T[]>,
  field: string,
): T[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return schema.parse(raw);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ValidationError(`--${field} must be a JSON array`);
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ValidationError(`Invalid --${field}: ${result.error.message}`);
  }
  return result.data;
}

export function parseFacts(raw: string | WorkerRecord | undefined): WorkerRecord | undefined {
  if (raw === undefined || typeof raw !== 'string') return raw;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ValidationError('--facts must be a JSON object');
  }
  const result = WorkerRecordSchema.safeParse(json);
  if (!result.success) {
    throw new ValidationError(`Invalid --facts: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Every category a session can leave behind needs an explicit answer, because
 * the alternative — silent omission — is the failure this command exists to
 * prevent. Each `empty` message deliberately does not name its own `--no-*`
 * escape hatch: an agent that reaches the error should be pointed at the work
 * of filing, not at the flag that silences the check. The flags are documented
 * in `--help` for the caller who genuinely has nothing to file.
 */
const GATES = {
  loops: {
    empty:
      'Refusing to wrap with an empty ledger. Pass --next-steps with the loops this ' +
      'session leaves open (anything a future session would need to pick up: ' +
      'unfinished work, open PRs, unanswered questions) and/or --resolves with the ' +
      'refs of prior loops it closed.',
    both: '--no-loops asserts an empty ledger; drop it to file --next-steps or --resolves.',
  },
  notes: {
    empty:
      'Refusing to wrap without an answer for durable notes. Pass --notes with what ' +
      'this session learned that no task would ever carry: process lessons, gotchas ' +
      'that cost time, decisions and why they were made, FYIs about the state of the ' +
      'worktree or the docs.',
    both: '--no-notes asserts this session produced no durable notes; drop it to file --notes.',
  },
  tasks: {
    empty:
      'Refusing to wrap without an answer for tasks. Pass --tasks-filed with the ids of ' +
      'the tasks created during this session — anything actionable that surfaced and ' +
      'must outlive the session must be a task before wrap returns.',
    both: '--no-tasks asserts no tasks were filed this session; drop it to file --tasks-filed.',
  },
} as const;

function requireAnswer(
  filled: boolean,
  none: boolean,
  messages: { empty: string; both: string },
): void {
  if (none) {
    if (filled) throw new ValidationError(messages.both);
    return;
  }
  if (!filled) throw new ValidationError(messages.empty);
}

export function requireAnswers(
  args: Args,
  ledger: Ledger,
  notes: NoteInput[],
  taskIds: string[],
): void {
  const hasLoops = ledger.next_steps.length > 0 || ledger.resolves.length > 0;
  requireAnswer(hasLoops, args.no_loops ?? false, GATES.loops);
  requireAnswer(notes.length > 0, args.no_notes ?? false, GATES.notes);
  requireAnswer(taskIds.length > 0, args.no_tasks ?? false, GATES.tasks);
}
