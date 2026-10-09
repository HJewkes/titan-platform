import { z } from "zod";

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// The round trip rejects dates the regex admits but the calendar does not, such as 2026-02-30.
const isValidIsoDate = (value: string): boolean => {
  if (!ISO_DATE_REGEX.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
};

export const isoDate = z
  .string()
  .refine(isValidIsoDate, { message: "Must be a valid zero-padded YYYY-MM-DD date" });

export const isoDateOrNull = z.union([isoDate, z.null()]);

export const TASK_ID_REGEX = /^[A-Z][A-Z0-9]*-\d+$/;

const taskId = z.string().regex(TASK_ID_REGEX, {
  message: "id must match /^[A-Z][A-Z0-9]*-\\d+$/ (e.g. EC-1)",
});

// Lives here, not in deliverable.ts, because deliverable.ts imports the date schemas from this file.
export const DELIVERABLE_ID_REGEX = /^[A-Za-z][A-Za-z0-9-]*$/;

export const deliverableId = z.string().regex(DELIVERABLE_ID_REGEX, {
  message: "deliverable id must match /^[A-Za-z][A-Za-z0-9-]*$/ (e.g. console-v1)",
});

const isUnique = (ids: string[]): boolean => new Set(ids).size === ids.length;

const uniqueTaskIds = z.array(taskId).refine(isUnique, { message: "dep ids must be unique" });

const uniqueDeliverableIds = z.array(deliverableId).refine(isUnique, { message: "deliverable ids must be unique" });

export const TaskSchema = z.object({
  id: taskId,
  parent: taskId.optional(),
  dep: uniqueTaskIds.optional(),
  deliverables: uniqueDeliverableIds.optional(),
  title: z.string().min(1),
  priority: z.number().int().positive(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  estimate: z.number().positive().optional(),
  done_when: z.string().min(1).optional(),
  // kind, status, cos and area are closed sets, but the set lives in the category registry, so
  // checkCategories validates the values and the schema only requires a non-empty string.
  status: z.string().min(1),
  kind: z.string().min(1).optional(),
  cos: z.string().min(1).optional(),
  area: z.string().min(1).optional(),
  due: isoDate.optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  created: isoDate,
  updated: isoDate,
  done_at: isoDateOrNull,
});

export type Task = z.infer<typeof TaskSchema>;
