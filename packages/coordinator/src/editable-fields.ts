import { z } from "zod";

/** When a reader of the surface sees a new value. */
export type ReloadClass = "live" | "per-spawn" | "restart";
export type ConfigSurface = "coordinator" | "agent-chat" | "factory";
export type EditableField = {
  surface: ConfigSurface;
  /** Dotted path within the surface; `*` matches exactly one segment. */
  pattern: string;
  bounds: { min: number; max: number; integer: boolean };
  schema: z.ZodNumber;
  reload: ReloadClass;
};
export type EditableValueResult =
  | { ok: true; field: EditableField; value: number }
  | { ok: false; reason: "not-editable" | "invalid"; message: string };

function field(surface: ConfigSurface, pattern: string, bounds: EditableField["bounds"], reload: ReloadClass) {
  const base = bounds.integer ? z.number().int() : z.number().finite();
  return { surface, pattern, bounds, schema: base.min(bounds.min).max(bounds.max), reload };
}

const caps = { min: 0, max: 64, integer: true };
const points = { min: 0, max: 1000, integer: false };
const percent = { min: 0, max: 100, integer: false };

/** The only config fields the console may edit; a path no row matches is refused. */
export const EDITABLE_FIELDS: readonly EditableField[] = [
  field("coordinator", "seats.*.concurrency.implementers", caps, "per-spawn"),
  field("coordinator", "seats.*.concurrency.reviewers", caps, "per-spawn"),
  field("coordinator", "seats.*.concurrency.planners", caps, "per-spawn"),
  field("coordinator", "seats.*.spend.*", points, "per-spawn"),
  field("coordinator", "limits.pools.*.ceiling_five_hour", percent, "per-spawn"),
  field("coordinator", "limits.pools.*.reserve_seven_day", percent, "per-spawn"),
  field("agent-chat", "worktreeBudget", { min: 1, max: 64, integer: true }, "per-spawn"),
  field("factory", "shepherd.spawnGate.load5", { min: 1, max: 256, integer: false }, "restart"),
];

function matches(pattern: string, path: string): boolean {
  const want = pattern.split(".");
  const have = path.split(".");
  return want.length === have.length && want.every((segment, i) => segment === "*" || segment === have[i]);
}

/** The row that makes `path` on `surface` editable, or undefined when none does. */
export function editableField(surface: string, path: string): EditableField | undefined {
  return EDITABLE_FIELDS.find((row) => row.surface === surface && matches(row.pattern, path));
}

/** Checks one proposed value against its row's bounds; never throws. */
export function checkEditableValue(surface: string, path: string, value: unknown): EditableValueResult {
  const row = editableField(surface, path);
  if (!row) return { ok: false, reason: "not-editable", message: `${surface}:${path} is not an editable field` };
  const parsed = row.schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: "invalid", message: `${surface}:${path}: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  }
  return { ok: true, field: row, value: parsed.data };
}
