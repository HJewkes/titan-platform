import { z } from 'zod';
import type { Task } from '../schemas/task.js';
import { UsageError } from '../errors.js';
import { DueArg } from './_categories.js';
import { QuietArg } from './_task-quiet.js';
import { parseOwnerSteps, TaskPlanArgsShape } from './_task-plan-fields.js';

const EDITABLE_FIELDS = [
  'title',
  'priority',
  'severity',
  'estimate',
  'done_when',
  'tags',
  'notes',
  'status',
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const ArgsSchema = z.object({
  slug: z.string().min(1),
  id: z.string().min(1),
  field: z.string().min(1).optional(),
  value: z.unknown().optional(),
  append: z.string().optional(),
  add_tag: z.string().optional(),
  remove_tag: z.string().optional(),
  parent: z.string().min(1).optional(),
  dep: z.array(z.string().min(1)).optional(),
  remove_dep: z.array(z.string().min(1)).optional(),
  deliverable: z.array(z.string().min(1)).optional(),
  kind: z.string().min(1).optional(),
  cos: z.string().min(1).optional(),
  area: z.string().min(1).optional(),
  due: DueArg,
  ...TaskPlanArgsShape,
  force: z.boolean().optional(),
  quiet: QuietArg,
});

export type Args = z.infer<typeof ArgsSchema>;

function isEditable(field: string): field is EditableField {
  return (EDITABLE_FIELDS as readonly string[]).includes(field);
}

/**
 * The CLI/MCP dispatcher can't coerce `value` generically because its type
 * depends on `field` at runtime (unlike other commands, where each arg has
 * a fixed zod type). Coerce here, against the field it's actually landing on.
 */
export function coerceValue(field: EditableField, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (field === 'priority' || field === 'estimate') {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (field === 'tags') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return value;
}

export const PATCH_FIELDS = ['kind', 'cos', 'area', 'due', 'bet', 'fold'] as const;

export type PatchField = (typeof PATCH_FIELDS)[number];

export interface PatchEdit {
  kind: 'patch';
  fields?: Partial<Pick<Task, PatchField>>;
  append?: string;
  addTag?: string;
  removeTag?: string;
  parent?: string;
  addDeps?: string[];
  removeDeps?: string[];
  addDeliverables?: string[];
  addOwnerSteps?: Task['owner_steps'];
}

export type Edit = { kind: 'field'; field: EditableField; value: unknown } | PatchEdit;

function fieldEdit(args: Args): Edit {
  const { field, value } = args;
  if (field === undefined || value === undefined) {
    throw new UsageError('The field form needs both <field> and <value>');
  }
  if (!isEditable(field)) {
    throw new UsageError(
      `Field is not editable: ${field} (allowed: ${EDITABLE_FIELDS.join(', ')})`,
    );
  }
  return { kind: 'field', field, value };
}

function noteLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (text.trim() === '') throw new UsageError('--append needs non-empty text');
  if (/[\r\n]/.test(text)) {
    throw new UsageError('--append takes one line; call it once per line');
  }
  return text;
}

function singleTag(flag: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const tag = raw.trim();
  if (tag === '') throw new UsageError(`${flag} needs a non-empty tag`);
  if (tag.includes(',')) throw new UsageError(`${flag} takes one tag per call: ${tag}`);
  return tag;
}

function patchEdit(args: Args): Edit {
  const append = noteLine(args.append);
  const addTag = singleTag('--add-tag', args.add_tag);
  const removeTag = singleTag('--remove-tag', args.remove_tag);
  if (addTag !== undefined && addTag === removeTag) {
    throw new UsageError(`--add-tag and --remove-tag name the same tag: ${addTag}`);
  }
  const overlap = (args.dep ?? []).filter((id) => args.remove_dep?.includes(id));
  if (overlap.length > 0) {
    throw new UsageError(`--dep and --remove-dep name the same id: ${overlap.join(', ')}`);
  }
  return {
    kind: 'patch',
    append,
    addTag,
    removeTag,
    parent: args.parent,
    addDeps: args.dep,
    removeDeps: args.remove_dep,
    addDeliverables: args.deliverable,
    addOwnerSteps: parseOwnerSteps(args.owner_step),
    fields: patchFields(args),
  };
}

function patchFields(args: Args): PatchEdit['fields'] {
  const set = PATCH_FIELDS.filter((key) => args[key] !== undefined);
  return set.length === 0 ? undefined : Object.fromEntries(set.map((key) => [key, args[key]]));
}

const PATCH_KEYS = [
  'append',
  'add_tag',
  'remove_tag',
  'parent',
  'dep',
  'remove_dep',
  'deliverable',
  'owner_step',
  ...PATCH_FIELDS,
] as const;

export function parseEdit(args: Args): Edit {
  const fieldForm = args.field !== undefined || args.value !== undefined;
  const flagForm = PATCH_KEYS.some((key) => args[key] !== undefined);
  if (fieldForm && flagForm) {
    throw new UsageError(
      'Pass either <field> <value> or --append/--add-tag/--remove-tag/--parent/--dep/--remove-dep/' +
        '--deliverable/--kind/--cos/--area/--due/--bet/--fold/--owner-step, not both',
    );
  }
  if (fieldForm) return fieldEdit(args);
  if (flagForm) return patchEdit(args);
  throw new UsageError(
    'Nothing to edit: pass <field> <value>, --append <text>, --add-tag <tag>, --remove-tag <tag>, ' +
      '--parent <id>, --dep <id>, --remove-dep <id>, --deliverable <id>, --kind, --cos, --area, ' +
      '--due, --bet, --fold or --owner-step',
  );
}
