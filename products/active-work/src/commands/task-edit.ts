import path from 'node:path';
import { assertPromotable } from './_draft-promotion.js';
import { readEdges } from '@titan-design/pm';
import { defineCommand, type CommandContext } from '../registry/index.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { getActiveRoot, getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { nowIso, today } from '../utils/today.js';
import { NotFoundError, UsageError, ValidationError } from '../errors.js';
import { assertEdgeWrite } from '../tasks/edge-index.js';
import { assertKnownBet } from './_bet-check.js';
import { assertKnownDeliverables } from './_deliverables.js';
import { assertCategories, CATEGORY_OPTIONS, changedCategoryFields } from './_categories.js';
import {
  ArgsSchema,
  PATCH_FIELDS,
  coerceValue,
  parseEdit,
  type Args,
  type Edit,
  type EditableField,
  type PatchEdit,
  type PatchField,
} from './_task-edit-parse.js';
import { quietOption, TaskOrLineSchema, quietOr, type TaskOrLine } from './_task-quiet.js';

interface TaskChange {
  changes: Partial<Task>;
  notices: string[];
}

function appendLine(notes: string | undefined, line: string): string {
  if (notes === undefined || notes === '') return line;
  return notes.endsWith('\n') ? `${notes}${line}\n` : `${notes}\n${line}`;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Writes the edges as fields, starting from readEdges so a tag-only edge is carried over. */
function edgeChange(task: Task, edit: PatchEdit): TaskChange {
  const changes: Partial<Task> = {};
  const notices: string[] = [];
  const { parent, addDeps = [], removeDeps = [] } = edit;
  if (parent !== undefined && parent !== task.parent) changes.parent = parent;
  if (parent !== undefined && parent === task.parent) notices.push(`Parent already ${parent}`);
  const current = readEdges(task).dep;
  for (const id of addDeps.filter((dep) => current.includes(dep))) {
    notices.push(`Dep already present, nothing added: ${id}`);
  }
  for (const id of removeDeps.filter((dep) => !current.includes(dep))) {
    notices.push(`Dep not present, nothing removed: ${id}`);
  }
  const dep = [...new Set([...current, ...addDeps])].filter((id) => !removeDeps.includes(id));
  if (!sameIds(dep, current)) changes.dep = dep;
  return { changes, notices };
}

function newDeliverables(task: Task, edit: PatchEdit): string[] {
  const current = task.deliverables ?? [];
  return [...new Set(edit.addDeliverables ?? [])].filter((id) => !current.includes(id));
}

function newFields(task: Task, edit: PatchEdit): [PatchField, string][] {
  return PATCH_FIELDS.flatMap((key) => {
    const value = edit.fields?.[key];
    return value === undefined || value === task[key] ? [] : [[key, value] as [PatchField, string]];
  });
}

function tagChange(
  current: readonly string[],
  { addTag, removeTag }: PatchEdit,
): { tags?: string[]; notices: string[] } {
  const notices: string[] = [];
  let tags: string[] | undefined;
  if (addTag !== undefined) {
    if (current.includes(addTag)) notices.push(`Tag already present, nothing added: ${addTag}`);
    else tags = [...current, addTag];
  }
  if (removeTag !== undefined) {
    if (current.includes(removeTag)) tags = (tags ?? [...current]).filter((t) => t !== removeTag);
    else notices.push(`Tag not present, nothing removed: ${removeTag}`);
  }
  return { tags, notices };
}

export function patchChange(task: Task, edit: PatchEdit): TaskChange {
  const current = task.tags ?? [];
  const { changes, notices } = edgeChange(task, edit);
  for (const key of PATCH_FIELDS) {
    if (edit.fields?.[key] !== undefined && edit.fields[key] === task[key]) {
      notices.push(`${key} already ${task[key]}`);
    }
  }
  Object.assign(changes, Object.fromEntries(newFields(task, edit)));
  const added = newDeliverables(task, edit);
  for (const id of (edit.addDeliverables ?? []).filter((d) => task.deliverables?.includes(d))) {
    notices.push(`Deliverable already present, nothing added: ${id}`);
  }
  if (added.length > 0) changes.deliverables = [...(task.deliverables ?? []), ...added];
  if (edit.append !== undefined) changes.notes = appendLine(task.notes, edit.append);
  const tags = tagChange(current, edit);
  if (tags.tags !== undefined) changes.tags = tags.tags;
  notices.push(...tags.notices);
  return { changes, notices };
}

function guardFieldEdit(task: Task, field: EditableField, value: unknown): void {
  if (field === 'notes' && typeof value === 'string') {
    const current = task.notes ?? '';
    if (!value.startsWith(current)) {
      throw new UsageError(
        `Refusing to replace notes (${current.length} chars): the new value does not keep them. ` +
          'Use --append to add a line, or pass --force to replace the notes',
      );
    }
  }
  if (field === 'tags' && Array.isArray(value)) {
    const dropped = (task.tags ?? []).filter((tag) => !value.includes(tag));
    if (dropped.length > 0) {
      throw new UsageError(
        `Refusing to drop existing tags: ${dropped.join(', ')}. ` +
          'Use --add-tag or --remove-tag to change one tag, or pass --force to replace the tags',
      );
    }
  }
  if (field === 'done_when' && (task.done_when ?? '').trim() !== '') {
    throw new UsageError('Refusing to replace a non-empty done_when. Pass --force to replace it');
  }
}

/** Wall-clock stamps a status change records: started_at once, on the first in-progress; reopening clears done_at. */
function statusStamps(task: Task, status: unknown): Partial<Task> {
  if (status === 'done') return { done_at: nowIso() };
  if (status === 'open') return { done_at: null };
  if (status === 'in-progress' && task.started_at === undefined) return { started_at: nowIso() };
  return {};
}

function changeFor(task: Task, edit: Edit, force: boolean): TaskChange {
  if (edit.kind === 'patch') return patchChange(task, edit);
  const value = coerceValue(edit.field, edit.value);
  if (!force) guardFieldEdit(task, edit.field, value);
  const changes: Record<string, unknown> = { [edit.field]: value };
  if (edit.field === 'status') Object.assign(changes, statusStamps(task, edit.value));
  return { changes, notices: [] };
}

async function loadTask(file: string, id: string): Promise<Task> {
  try {
    return await readYaml(file, TaskSchema);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NotFoundError(`Task not found: ${id}`);
    }
    throw err;
  }
}

function edgeParts(task: Task, edit: PatchEdit): string[] {
  const current = readEdges(task).dep;
  const parts: string[] = [];
  if (edit.parent !== undefined && edit.parent !== task.parent) parts.push(`parent ${edit.parent}`);
  for (const id of edit.addDeps ?? []) if (!current.includes(id)) parts.push(`+dep ${id}`);
  for (const id of edit.removeDeps ?? []) if (current.includes(id)) parts.push(`-dep ${id}`);
  return parts;
}

/**
 * Names what the edit changed: the field, "notes", "+tag x", "-tag x", "parent x", "+dep x",
 * "-dep x", "+deliverable x" or "kind x" (likewise cos, area and due).
 */
function editedLine(task: Task, edit: Edit): string {
  if (edit.kind === 'field') return `${task.id} edited: ${edit.field}`;
  const tags = task.tags ?? [];
  const parts: string[] = [];
  if (edit.append !== undefined) parts.push('notes');
  if (edit.addTag !== undefined && !tags.includes(edit.addTag)) parts.push(`+tag ${edit.addTag}`);
  if (edit.removeTag !== undefined && tags.includes(edit.removeTag)) {
    parts.push(`-tag ${edit.removeTag}`);
  }
  parts.push(...edgeParts(task, edit));
  parts.push(...newDeliverables(task, edit).map((id) => `+deliverable ${id}`));
  parts.push(...newFields(task, edit).map(([key, value]) => `${key} ${value}`));
  return parts.length === 0 ? `${task.id} unchanged` : `${task.id} edited: ${parts.join(', ')}`;
}

// Removing an edge cannot name an unknown id or close a cycle, so only an added edge needs
// the whole-root edge check (and a malformed file elsewhere must not block a removal).
function addsEdge(task: Task, changes: Partial<Task>): boolean {
  if (changes.parent !== undefined) return true;
  const current = readEdges(task).dep;
  return (changes.dep ?? []).some((id) => !current.includes(id));
}

function announce(ctx: CommandContext, notices: string[]): void {
  ctx.warnings.push(...notices);
  if (ctx.format === 'json') return;
  for (const notice of notices) process.stderr.write(`${notice}\n`);
}

async function assertWritable(
  task: Task,
  next: Task,
  changes: Partial<Task>,
  edit: Edit,
  ctx: CommandContext,
  slug: string,
): Promise<void> {
  assertPromotable(ctx, task, next);
  if (changes.bet !== undefined) await assertKnownBet(next);
  await assertCategories(getActiveRoot(), next, changedCategoryFields(changes));
  const added = edit.kind === 'patch' ? newDeliverables(task, edit) : [];
  if (added.length > 0) await assertKnownDeliverables(getActiveRoot(), added);
  if (addsEdge(task, changes)) {
    await assertEdgeWrite({ slug, id: task.id, parent: changes.parent, dep: changes.dep });
  }
}

async function editLocked(args: Args, ctx: CommandContext, edit: Edit): Promise<TaskOrLine> {
  const file = path.join(getInitiativeDir(args.slug), 'tasks', `${args.id}.yml`);
  const task = await loadTask(file, args.id);
  const date = today();
  const { changes, notices } = changeFor(task, edit, args.force === true);
  announce(ctx, notices);
  const line = (): string => editedLine(task, edit);
  if (Object.keys(changes).length === 0) return quietOr(args.quiet, ctx, task, line);
  const next = { ...task, ...changes };
  await assertWritable(task, next, changes, edit, ctx, args.slug);
  const parsed = TaskSchema.safeParse({ ...next, updated: date });
  if (!parsed.success) {
    const target = args.field ?? Object.keys(changes).join(', ');
    throw new ValidationError(`Invalid value for ${target}: ${parsed.error.message}`);
  }
  await writeYaml(file, parsed.data, TaskSchema);
  return quietOr(args.quiet, ctx, parsed.data, line);
}

export default defineCommand<Args, TaskOrLine>({
  name: 'task.edit',
  description:
    'Edit a single field on a task, append a note line, add/remove one tag, set parent and deps, ' +
    'or set kind, cos, area and due (checked against the category registry)',
  args: ArgsSchema,
  result: TaskOrLineSchema,
  cli: {
    positional: ['slug', 'id', 'field', 'value'],
    options: {
      append: {
        long: '--append',
        description: 'Append one line to notes, keeping the rest',
      },
      add_tag: {
        long: '--add-tag',
        description: 'Add one tag, keeping the others',
      },
      remove_tag: {
        long: '--remove-tag',
        description: 'Remove one tag, keeping the others',
      },
      parent: {
        long: '--parent',
        description: 'Set the parent task id, in this initiative',
      },
      dep: {
        long: '--dep',
        description: 'Id to add as a dep (any initiative). Repeat the flag for each value',
      },
      remove_dep: {
        long: '--remove-dep',
        description: 'Id to drop from deps. Repeat the flag for each value',
      },
      deliverable: {
        long: '--deliverable',
        description: 'Deliverable id to add, keeping the others. Repeat the flag for each value',
      },
      ...CATEGORY_OPTIONS,
      force: {
        long: '--force',
        description: 'Let the field form replace notes, drop tags or replace a non-empty done_when',
      },
      quiet: quietOption('PRJ-12 edited: notes'),
    },
  },
  async run(args, ctx) {
    const edit = parseEdit(args);
    getActiveRoot();
    return withFileLock(getLockPath(args.slug), () => editLocked(args, ctx, edit));
  },
});
