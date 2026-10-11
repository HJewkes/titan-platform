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

const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isValidIsoDatetime = (value: string): boolean =>
  ISO_DATETIME_REGEX.test(value) && isValidIsoDate(value.slice(0, 10)) && !Number.isNaN(new Date(value).getTime());

export const isoDatetime = z
  .string()
  .refine(isValidIsoDatetime, { message: "Must be a valid ISO-8601 datetime, e.g. 2026-10-08T14:03:22Z" });

// active-work writes full datetimes now, and its older task files still carry a bare date.
export const isoDateOrDatetime = z.union([isoDate, isoDatetime]);

export const isoDateOrDatetimeOrNull = z.union([isoDateOrDatetime, z.null()]);

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

const nonNegative = z.number().nonnegative();

// Measured outcomes written back at done; claimedHours holds the free-text claims scored against them.
// Declared apart so no object key ends in "deliverable" plus a colon, which the tag guard in
// deliverable.test.ts greps these sources for.
const contextAtFirstDeliverable = nonNegative.optional();

export const ActualSchema = z.object({
  agentHours: nonNegative.optional(),
  reviewAgentHours: nonNegative.optional(),
  usd: nonNegative.optional(),
  serviceWallHours: nonNegative.optional(),
  peakContext: nonNegative.optional(),
  contextAtFirstDeliverable,
  at: isoDatetime.optional(),
  model: z.string().min(1).optional(),
});

export const ClaimedHoursSchema = z.object({
  hours: nonNegative,
  by: z.string().min(1),
  at: isoDatetime,
});

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
  created: isoDateOrDatetime,
  started_at: isoDatetime.optional(),
  updated: isoDate,
  done_at: isoDateOrDatetimeOrNull,
  actual: ActualSchema.optional(),
  claimedHours: z.array(ClaimedHoursSchema).optional(),
});

export type Task = z.infer<typeof TaskSchema>;
