import { promises as fs } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import {
  BUILT_IN_STATUSES,
  categoriesPath,
  checkCategories,
  parseCategoryRegistry,
  type CategoryError,
  type CategoryRegistry,
} from '@titan-design/pm';
import { ValidationError } from '../errors.js';
import type { CommandContext } from '../registry/index.js';
import type { Task } from '../schemas/task.js';
import { today } from '../utils/today.js';

const CATEGORY_FIELDS = ['status', 'kind', 'cos', 'area', 'due'] as const;

type CategoryField = (typeof CATEGORY_FIELDS)[number];

const DUE_FORMS = 'due must be YYYY-MM-DD, +Nd or +Nw (N a positive integer)';

/** Resolves +Nd and +Nw against today, so the stored due is always an absolute date. */
function resolveDue(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = /^\+([1-9]\d*)([dw])$/.exec(value);
  if (match === null) return null;
  const [year = 0, month = 1, day = 1] = today().split('-').map(Number);
  const days = Number(match[1]) * (match[2] === 'w' ? 7 : 1);
  return formatLocalDate(new Date(year, month - 1, day + days));
}

function formatLocalDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// overwrite, not transform: a transform cannot be represented in the MCP tool's JSON schema,
// which must keep advertising a plain string.
export const DueArg = z
  .string()
  .refine((value) => resolveDue(value) !== null, { message: DUE_FORMS, abort: true })
  .overwrite((value) => resolveDue(value) ?? value)
  .optional();

/** The shared CLI flags for the category fields of task add and task edit. */
export const CATEGORY_OPTIONS = {
  kind: { long: '--kind', description: 'Kind, from the category registry (e.g. feature, epic)' },
  cos: { long: '--cos', description: 'Class of service, from the category registry' },
  area: { long: '--area', description: 'Area (package or product), from the category registry' },
  due: { long: '--due', description: 'Due date, YYYY-MM-DD, +Nd or +Nw (cos fixed needs one)' },
};

/**
 * The category registry, or null when the root has no categories.yml: such a root (a private
 * one) skips validation of kind, cos and area, and keeps the built-in statuses.
 */
export async function loadCategoryRegistry(activeRoot: string): Promise<CategoryRegistry | null> {
  const file = categoriesPath(activeRoot);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return parseCategoryRegistry(YAML.parse(raw));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`${file} is not a valid category registry: ${reason}`);
  }
}

function describe(error: CategoryError): string {
  if (error.kind === 'cos-fixed-without-due')
    return 'cos fixed needs a due date (--due YYYY-MM-DD)';
  return `Unknown ${error.axis}: ${error.value} (allowed: ${error.allowed.join(', ')})`;
}

// Only the axes this write touches are checked, so a value that predates the registry does not
// block an unrelated edit; changing cos or due re-checks the fixed-needs-due rule.
function touches(error: CategoryError, changed: ReadonlySet<string>): boolean {
  if (error.kind === 'cos-fixed-without-due') return changed.has('cos') || changed.has('due');
  return changed.has(error.axis);
}

export function changedCategoryFields(
  changes: Partial<Pick<Task, CategoryField>>,
): CategoryField[] {
  return CATEGORY_FIELDS.filter((field) => changes[field] !== undefined);
}

/** Throws a ValidationError naming each unknown value's axis and the allowed values. */
export async function assertCategories(
  activeRoot: string,
  task: Task,
  changed: readonly CategoryField[],
): Promise<void> {
  if (changed.length === 0) return;
  const registry = await loadCategoryRegistry(activeRoot);
  const changedSet = new Set<string>(changed);
  const errors = checkCategories(task, registry).filter((e) => touches(e, changedSet));
  if (errors.length === 0) return;
  throw new ValidationError(`${task.id}: ${errors.map(describe).join('; ')}`);
}

/** The statuses that close a task, from the registry or the built-in set. */
export async function closedStatusIds(activeRoot: string): Promise<Set<string>> {
  const statuses = (await loadCategoryRegistry(activeRoot))?.status ?? BUILT_IN_STATUSES;
  return new Set(statuses.filter((s) => s.closed).map((s) => s.id));
}

/** Records a warning for the JSON envelope and, for a human, prints it to stderr. */
export function warn(ctx: CommandContext, message: string): void {
  ctx.warnings.push(message);
  if (ctx.format !== 'json') process.stderr.write(`${message}\n`);
}
