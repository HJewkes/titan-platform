import { TaskRequireSchema, type TaskRequire } from '@titan-design/pm';
import { z } from 'zod';
import { UsageError, ValidationError } from '../errors.js';
import type { CommandContext } from '../registry/index.js';
import { planRecordExists } from '../plan/store.js';
import { TaskSchema, type Task } from '../schemas/task.js';

/*
 * The provenance fields a filer sets (TP-5446 plan, section 3.1). `filed_by` comes from the process environment and
 * never from an argument, so a filer cannot claim another's work. No argument writes `rank` or a `field_origin` of
 * `owner`: those are owner actions, which no CLI or RPC path carries (they arrive as console owner operations).
 */

export const TaskProvenanceArgsShape = {
  class: TaskSchema.shape.class,
  serves: TaskSchema.shape.serves,
  source: TaskSchema.shape.source,
  source_ref: z.string().trim().min(1).optional(),
  from_pr: z.string().min(1).optional(),
  from_task: z.string().min(1).optional(),
  blocked_on: TaskSchema.shape.blocked_on,
};

/** Every provenance argument, so a parser can tell a provenance edit from no edit. */
export const PROVENANCE_ARG_KEYS = [
  'class',
  'serves',
  'source',
  'source_ref',
  'from_pr',
  'from_task',
  'blocked_on',
] as const satisfies readonly (keyof typeof TaskProvenanceArgsShape)[];

export const TASK_PROVENANCE_OPTIONS = {
  class: { long: '--class', description: 'product|upkeep' },
  serves: { long: '--serves', description: 'Outcome id this task serves (alpha/faster-landing), or none' },
  source: {
    long: '--source',
    description: 'owner|plan|follow-up|review|sweep|audit|coordinator|incident',
  },
  source_ref: {
    long: '--source-ref',
    description: 'What the source points at: a decision or owner-queue id for owner, path#slice for plan',
  },
  from_pr: { long: '--from-pr', description: 'PR a follow-up or review finding came from (owner/repo#12)' },
  from_task: { long: '--from-task', description: 'Task that PR served, with --from-pr' },
  blocked_on: { long: '--blocked-on', description: 'owner|decision|task|external' },
};

type ProvenanceArgs = { [K in keyof typeof TaskProvenanceArgsShape]?: z.infer<(typeof TaskProvenanceArgsShape)[K]> };

export type ProvenanceField = 'class' | 'serves' | 'source' | 'source_ref' | 'blocked_on';

const PROVENANCE_FIELDS = ['class', 'serves', 'source', 'source_ref', 'blocked_on'] as const satisfies readonly ProvenanceField[];

/** Fields that move a task's scorecard row, so only the owner may change them once the task is dispatched. */
const DISPATCH_LOCKED_FIELDS = ['class', 'source', 'serves'] as const satisfies readonly ProvenanceField[];

function sourceRefArg(args: ProvenanceArgs): Task['source_ref'] {
  const { source_ref: text, from_pr: fromPr, from_task: fromTask } = args;
  if (fromPr === undefined && fromTask === undefined) return text;
  if (text !== undefined) throw new UsageError('Pass --source-ref or --from-pr with --from-task, not both');
  if (fromPr === undefined || fromTask === undefined) throw new UsageError('--from-pr and --from-task go together');
  return { from_pr: fromPr, from_task: fromTask };
}

/** The provenance values the arguments set, without origins. */
export function provenanceArgs(args: ProvenanceArgs): Partial<Pick<Task, ProvenanceField>> {
  const values = {
    class: args.class,
    serves: args.serves,
    source: args.source,
    source_ref: sourceRefArg(args),
    blocked_on: args.blocked_on,
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

/** Marks each named field as set by the filer, keeping the origins of the others. */
export function filedOrigins(current: Task['field_origin'], fields: readonly string[]): Task['field_origin'] {
  if (fields.length === 0) return current;
  return { ...current, ...Object.fromEntries(fields.map((field) => [field, 'filed'])) };
}

const AGENT_NAME = /^[A-Za-z0-9][\w.-]*$/;

/** The broker names every agent it spawns; an owner's own terminal sets no agent variable at all. */
export function filedBy(env: NodeJS.ProcessEnv, caller: CommandContext['caller']): string {
  const name = env.AGENT_CHAT_NAME?.trim();
  if (name) return AGENT_NAME.test(name) ? name : 'unknown';
  return caller === 'agent' ? 'unknown' : 'owner';
}

function briefRequire(frontmatter: Record<string, unknown>): TaskRequire {
  const parsed = TaskRequireSchema.optional().safeParse(frontmatter.task_require);
  if (!parsed.success) throw new ValidationError(`The brief's task_require is invalid: ${parsed.error.message}`);
  return parsed.data ?? [];
}

/** Refuses a new task that leaves out a field its initiative's brief lists in `task_require`. */
export function assertRequiredFields(frontmatter: Record<string, unknown>, task: Partial<Task>): void {
  const missing = briefRequire(frontmatter).filter((field) => task[field] === undefined);
  if (missing.length === 0) return;
  const flags = missing.map((field) => `--${field.replace('_', '-')}`).join(', ');
  throw new ValidationError(`This initiative's brief requires ${missing.join(', ')} on new tasks: pass ${flags}`);
}

/** Refuses a task whose values do not fit together (a source_ref that does not fit its source) or name an unknown outcome. */
export async function assertProvenance(activeRoot: string, task: Task): Promise<void> {
  const parsed = TaskSchema.safeParse(task);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join('; '));
  if (task.serves === undefined || task.serves === 'none') return;
  if (!(await planRecordExists(activeRoot, 'outcome', task.serves))) {
    throw new ValidationError(`Unknown outcome id: ${task.serves}`);
  }
}

/** Whether the task has been dispatched: started, or named by a spawn. */
type DispatchCheck = (task: Task) => Promise<boolean>;

/** Refuses a CLI or RPC edit to class, source or serves once the task is dispatched; only the owner relabels then. */
export async function assertNotRelabel(task: Task, changes: Partial<Task>, dispatched: DispatchCheck): Promise<void> {
  const locked = DISPATCH_LOCKED_FIELDS.filter((field) => field in changes && changes[field] !== task[field]);
  if (locked.length === 0 || !(await dispatched(task))) return;
  throw new UsageError(
    `Refusing to change ${locked.join(', ')} on ${task.id}: it is already dispatched, and after dispatch only the ` +
      'owner relabels a task, from the console',
  );
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const describeValue = (value: Task['source_ref']): string =>
  typeof value === 'object' ? `${value.from_pr} ${value.from_task}` : String(value);

/** The provenance values an edit changes, with their origins marked filed, and an "x value" part for each. */
export function provenanceChange(
  task: Task,
  values: Partial<Pick<Task, ProvenanceField>> | undefined,
): { changes: Partial<Task>; parts: string[] } {
  const changed = PROVENANCE_FIELDS.filter((field) => values?.[field] !== undefined && !sameValue(values[field], task[field]));
  if (changed.length === 0) return { changes: {}, parts: [] };
  const changes: Partial<Task> = Object.fromEntries(changed.map((field) => [field, values?.[field]]));
  changes.field_origin = filedOrigins(task.field_origin, changed);
  return { changes, parts: changed.map((field) => `${field} ${describeValue(values?.[field])}`) };
}
