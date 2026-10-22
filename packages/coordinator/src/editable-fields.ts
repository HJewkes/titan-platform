import { z } from "zod";

/** When a reader of the surface sees a new value. */
export type ReloadClass = "live" | "per-spawn" | "restart";
export type ConfigSurface = "coordinator" | "agent-chat" | "factory";
export type EditableValue = number | string | readonly string[];
export type EditableField = {
  surface: ConfigSurface;
  /** Dotted path within the surface; `*` matches exactly one segment. */
  pattern: string;
  /** Present on numeric rows only; a non-numeric row's limits live in its schema. */
  bounds?: { min: number; max: number; integer: boolean };
  schema: z.ZodType<EditableValue>;
  reload: ReloadClass;
};
export type EditableValueResult =
  | { ok: true; field: EditableField; value: EditableValue }
  | { ok: false; reason: "not-editable" | "invalid"; message: string };

type Bounds = NonNullable<EditableField["bounds"]>;

function field(surface: ConfigSurface, pattern: string, bounds: Bounds, reload: ReloadClass): EditableField {
  const base = bounds.integer ? z.number().int() : z.number().finite();
  return { surface, pattern, bounds, schema: base.min(bounds.min).max(bounds.max), reload };
}

function shaped(surface: ConfigSurface, pattern: string, schema: EditableField["schema"], reload: ReloadClass): EditableField {
  return { surface, pattern, schema, reload };
}

const caps = { min: 0, max: 64, integer: true };
const points = { min: 0, max: 1000, integer: false };
const percent = { min: 0, max: 100, integer: false };
const load = { min: 1, max: 256, integer: false };

/** Mirrors the factory's own argv-word rule, so a value that reads as a flag or holds whitespace is refused here first. */
const argvWord = z
  .string()
  .refine((value) => !value.includes("\0"), "must not contain a NUL byte")
  .regex(/^[^-\s]\S*$/, "must be one argument: not empty, no leading dash, no whitespace");
const profileName = argvWord.refine((value) => !value.includes("/") && !value.includes(".."), "must not contain a slash or ..");
const absoluteDir = argvWord.refine((value) => value.startsWith("/"), "must be an absolute path");
const onOff = z.enum(["off", "on"]);

/** The only config fields the console may edit; a path no row matches is refused. */
export const EDITABLE_FIELDS: readonly EditableField[] = [
  field("coordinator", "seats.*.concurrency.implementers", caps, "per-spawn"),
  field("coordinator", "seats.*.concurrency.reviewers", caps, "per-spawn"),
  field("coordinator", "seats.*.concurrency.planners", caps, "per-spawn"),
  field("coordinator", "seats.*.spend.*", points, "per-spawn"),
  field("coordinator", "limits.pools.*.ceiling_five_hour", percent, "per-spawn"),
  field("coordinator", "limits.pools.*.reserve_seven_day", percent, "per-spawn"),
  field("agent-chat", "worktreeBudget", { min: 1, max: 64, integer: true }, "per-spawn"),
  field("factory", "shepherd.spawnGate.load5", load, "live"),
  field("factory", "shepherd.spawnGate.buildLoad5", load, "live"),
  shaped("factory", "shepherd.gateReset.noReproProceed", onOff, "live"),
  shaped("factory", "shepherd.gateReset.heldRepair", onOff, "live"),
  shaped("factory", "shepherd.gateReset.twoMergeRelease", z.enum(["off", "shadow", "on"]), "live"),
  shaped("factory", "shepherd.review.adversaryProfile", profileName, "live"),
  shaped("factory", "shepherd.review.fallbackConfigDirs", z.array(absoluteDir).max(16), "live"),
  field("factory", "shepherd.review.maxConcurrent", { min: 1, max: 64, integer: true }, "live"),
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

/** Checks one proposed value against its row's schema; never throws. */
export function checkEditableValue(surface: string, path: string, value: unknown): EditableValueResult {
  const row = editableField(surface, path);
  if (!row) return { ok: false, reason: "not-editable", message: `${surface}:${path} is not an editable field` };
  const parsed = row.schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: "invalid", message: `${surface}:${path}: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  }
  return { ok: true, field: row, value: parsed.data };
}
