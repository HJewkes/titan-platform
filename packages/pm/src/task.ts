import { z } from "zod";

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// The round trip rejects dates the regex admits but the calendar does not, such as 2026-02-30.
const isValidIsoDate = (value: string): boolean => {
  if (!ISO_DATE_REGEX.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
};

const isoDate = z
  .string()
  .refine(isValidIsoDate, { message: "Must be a valid zero-padded YYYY-MM-DD date" });

const isoDateOrNull = z.union([isoDate, z.null()]);

export const TASK_ID_REGEX = /^[A-Z][A-Z0-9]*-\d+$/;

const taskId = z.string().regex(TASK_ID_REGEX, {
  message: "id must match /^[A-Z][A-Z0-9]*-\\d+$/ (e.g. EC-1)",
});

const uniqueTaskIds = z
  .array(taskId)
  .refine((ids) => new Set(ids).size === ids.length, { message: "dep ids must be unique" });

export const TaskSchema = z.object({
  id: taskId,
  parent: taskId.optional(),
  dep: uniqueTaskIds.optional(),
  title: z.string().min(1),
  priority: z.number().int().positive(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  estimate: z.number().positive().optional(),
  done_when: z.string().min(1).optional(),
  status: z.enum(["open", "done"]),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  created: isoDate,
  updated: isoDate,
  done_at: isoDateOrNull,
});

export type Task = z.infer<typeof TaskSchema>;
