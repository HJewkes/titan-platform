import { z } from "zod";
import type { Task } from "./task.js";

const CATEGORY_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

const REQUIRED_STATUSES = ["open", "done", "wont-do", "icebox"];
const REQUIRED_KINDS = ["epic"];
const FIXED_COS = "fixed";

const categoryId = z.string().regex(CATEGORY_ID_REGEX, {
  message: "category id must match /^[a-z0-9][a-z0-9-]*$/ (e.g. wont-do)",
});

const StatusEntrySchema = z.object({
  id: categoryId,
  closed: z.boolean(),
  dispatchable: z.boolean(),
});

// Tiers mirror the `$tiers` keys in .codewatch/check.json; products outside this repo use "product".
const AreaEntrySchema = z.object({
  id: categoryId,
  tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal("ui"), z.literal("product")]),
  path: z.string().min(1).optional(),
});

const checkIds = (ids: readonly string[], required: readonly string[], ctx: z.RefinementCtx): void => {
  const repeated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (repeated.length > 0) ctx.addIssue({ code: "custom", message: `repeated ids: ${repeated.join(", ")}` });
  const missing = required.filter((id) => !ids.includes(id));
  if (missing.length > 0) ctx.addIssue({ code: "custom", message: `must include: ${missing.join(", ")}` });
};

const idOf = (entry: { id: string }): string => entry.id;

/** The closed category axes, read from `<activeRoot>/titan-platform/categories.yml`. */
export const CategoryRegistrySchema = z.object({
  kind: z.array(categoryId).superRefine((ids, ctx) => checkIds(ids, REQUIRED_KINDS, ctx)),
  status: z.array(StatusEntrySchema).superRefine((es, ctx) => checkIds(es.map(idOf), REQUIRED_STATUSES, ctx)),
  cos: z.array(categoryId).superRefine((ids, ctx) => checkIds(ids, [], ctx)),
  area: z.array(AreaEntrySchema).superRefine((es, ctx) => checkIds(es.map(idOf), [], ctx)),
});

export type CategoryRegistry = z.infer<typeof CategoryRegistrySchema>;
export type StatusEntry = z.infer<typeof StatusEntrySchema>;
export type AreaEntry = z.infer<typeof AreaEntrySchema>;
export type CategoryAxis = "kind" | "status" | "cos" | "area";

/** The statuses a root with no registry accepts: the set tasks used before the registry existed. */
export const BUILT_IN_STATUSES: readonly StatusEntry[] = [
  { id: "open", closed: false, dispatchable: true },
  { id: "done", closed: true, dispatchable: false },
];

export function categoriesPath(activeRoot: string): string {
  return `${activeRoot.replace(/\/+$/, "")}/titan-platform/categories.yml`;
}

/**
 * Validates the parsed contents of categories.yml. Pass `undefined` when the file does not exist,
 * which returns null: a root with no registry skips validation of kind, cos and area. An empty file
 * parses to null, not undefined, and fails, so a registry cannot be switched off by emptying it.
 */
export function parseCategoryRegistry(parsed: unknown): CategoryRegistry | null {
  return parsed === undefined ? null : CategoryRegistrySchema.parse(parsed);
}

export type CategoryError =
  | { kind: "unknown-category"; id: string; axis: CategoryAxis; value: string; allowed: string[] }
  | { kind: "cos-fixed-without-due"; id: string };

export type CategorizedTask = Pick<Task, "id" | "status" | "kind" | "cos" | "area" | "due">;

const allowedValues = (registry: CategoryRegistry | null): Record<CategoryAxis, string[] | null> => ({
  kind: registry ? registry.kind : null,
  status: (registry ? registry.status : BUILT_IN_STATUSES).map(idOf),
  cos: registry ? registry.cos : null,
  area: registry ? registry.area.map(idOf) : null,
});

/**
 * Checks a task's category values against the registry, one error per unknown value. A null
 * registry checks status against BUILT_IN_STATUSES and skips kind, cos and area. A task with
 * cos `fixed` and no `due` is an error with or without a registry, because the date is what
 * makes the class of service fixed.
 */
export function checkCategories(task: CategorizedTask, registry: CategoryRegistry | null): CategoryError[] {
  const allowed = allowedValues(registry);
  const axes: CategoryAxis[] = ["kind", "status", "cos", "area"];
  const unknown = axes.flatMap((axis): CategoryError[] => {
    const value = task[axis];
    const values = allowed[axis];
    if (value === undefined || values === null || values.includes(value)) return [];
    return [{ kind: "unknown-category", id: task.id, axis, value, allowed: values }];
  });
  const fixedWithoutDue: CategoryError[] =
    task.cos === FIXED_COS && task.due === undefined ? [{ kind: "cos-fixed-without-due", id: task.id }] : [];
  return [...unknown, ...fixedWithoutDue];
}
