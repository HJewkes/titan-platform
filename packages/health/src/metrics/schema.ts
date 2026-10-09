import { z } from "zod";

export const METRICS_SCHEMA_ID = "titan.metrics/v1";
export const AUDIT_SCHEMA_ID = "titan.measurement-audit/v1";

export const METRIC_FAMILIES = [
  "availability",
  "flow",
  "quality",
  "owner-load",
  "cost",
  "business",
] as const;
export const METRIC_UNITS = [
  "count",
  "ratio",
  "minutes",
  "hours",
  "usd",
  "tokens",
] as const;
export const CADENCES = ["1m", "1h", "1d", "1w"] as const;
export const SURFACES = [
  "status",
  "stats",
  "health",
  "dashboard",
  "digest",
] as const;

type Mode = "write" | "read";

type ObjectFactory = <T extends z.ZodRawShape>(shape: T) => z.ZodObject<T>;

// Every object is built twice from one shape: strict for producers, loose so a reader keeps keys a newer writer added.
function dual<S extends z.ZodRawShape>(
  shape: (obj: ObjectFactory) => S,
  mode: Mode
) {
  const make = (obj: ObjectFactory) => obj(shape(obj));
  return mode === "write"
    ? make(z.strictObject as ObjectFactory)
    : make(z.looseObject as ObjectFactory);
}

const storeShape = (obj: ObjectFactory) =>
  obj({
    id: z.string().min(1),
    kind: z.enum(["sqlite", "jsonl", "log", "http", "cli"]),
    path: z.string().optional(),
    url: z.string().optional(),
    command: z.string().optional(),
    readonly: z.literal(true),
  });

const sourceShape = (obj: ObjectFactory) =>
  obj({
    anchor: z.string(),
    store: z.string(),
    captured: z.enum(["Y", "P", "N"]),
    gapSlice: z.string().optional(),
  });

const queryShape = (obj: ObjectFactory) =>
  obj({
    kind: z.enum(["sql", "http", "cli"]),
    store: z.string(),
    text: z.string(),
    valuePath: z.string().optional(),
    group: z.array(z.string()).optional(),
  });

const sloShape = (obj: ObjectFactory) =>
  obj({
    objective: z.string(),
    target: z.number(),
    op: z.enum(["<=", ">=", "between"]),
    window: z.enum(["1d", "7d", "28d"]),
    alert: obj({ threshold: z.number(), sustain: z.number().int().positive() }),
  });

const metricShape = (obj: ObjectFactory) =>
  obj({
    id: z.string().min(1),
    family: z.enum(METRIC_FAMILIES),
    title: z.string(),
    definition: z.string(),
    unit: z.enum(METRIC_UNITS),
    source: sourceShape(obj),
    query: queryShape(obj).optional(),
    cadence: z.enum(CADENCES),
    slo: sloShape(obj).optional(),
    surfaces: z.array(z.enum(SURFACES)),
    answers: z.array(z.number().int()),
  });

const reportRefShape = (obj: ObjectFactory) =>
  obj({
    id: z.string(),
    title: z.string(),
    metrics: z.array(z.string()),
    view: z.string().optional(),
    command: z.string().optional(),
  });

const entryShape = (obj: ObjectFactory) => ({
  schema: z.literal(METRICS_SCHEMA_ID),
  area: z.string().min(1),
  owner: z.string().min(1),
  stores: z.array(storeShape(obj)),
  metrics: z.array(metricShape(obj)),
  reports: z.array(reportRefShape(obj)),
  lastAudit: obj({ at: z.string(), codeRev: z.string(), report: z.string() }),
});

const auditInputShape = (obj: ObjectFactory) =>
  obj({
    system: z.string(),
    codeRoots: z.array(z.string()),
    stores: z.array(storeShape(obj)),
    surfaces: z.array(z.string()),
    sources: z.array(z.string()).optional(),
    owner: z.string(),
    mode: z.enum(["initial", "reaudit"]),
  });

const questionShape = (obj: ObjectFactory) =>
  obj({
    id: z.number().int(),
    text: z.string(),
    answerable: z.enum(["yes", "partly", "no"]),
    command: z.string().optional(),
  });

const baselinedMetricShape = (obj: ObjectFactory) =>
  obj({
    ...metricShape(obj).shape,
    baseline: obj({
      value: z.number().nullable(),
      n: z.number().int().nonnegative(),
      error: z.string().optional(),
    }).optional(),
  });

const countsShape = (obj: ObjectFactory) =>
  obj({
    proposed: z.number().int(),
    Y: z.number().int(),
    P: z.number().int(),
    N: z.number().int(),
    slices: z.number().int(),
  });

const gapShape = (obj: ObjectFactory) =>
  obj({
    rank: z.number().int(),
    metric: z.array(z.string()),
    slice: obj({
      title: z.string(),
      done_when: z.string(),
      estimate: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    }),
  });

const auditShape = (obj: ObjectFactory) => ({
  schema: z.literal(AUDIT_SCHEMA_ID),
  system: z.string().min(1),
  mode: z.enum(["initial", "reaudit"]),
  at: z.string(),
  codeRev: z.string(),
  inputs: auditInputShape(obj),
  inventory: obj({ data: z.unknown(), emitters: z.unknown() }),
  purpose: z.string(),
  users: z.array(z.string()),
  questions: z.array(questionShape(obj)),
  metrics: z.array(baselinedMetricShape(obj)),
  counts: countsShape(obj),
  gaps: z.array(gapShape(obj)),
  reports: z.array(reportRefShape(obj)),
  drift: z.array(z.unknown()).optional(),
  extra: z.record(z.string(), z.unknown()),
});

/** Write schemas refuse unknown keys; read schemas keep them so an older reader survives a newer writer. */
export const metricsEntrySchema = dual(entryShape, "write");
export const metricsEntryReadSchema = dual(entryShape, "read");
export const measurementAuditSchema = dual(auditShape, "write");
export const measurementAuditReadSchema = dual(auditShape, "read");

export type MetricsEntry = z.infer<typeof metricsEntrySchema>;
export type MetricSpec = MetricsEntry["metrics"][number];
export type MeasurementAudit = z.infer<typeof measurementAuditSchema>;
export type MetricsEntryRead = z.infer<typeof metricsEntryReadSchema>;
export type MeasurementAuditRead = z.infer<typeof measurementAuditReadSchema>;

export type ValidateResult<T> =
  | { ok: true; entry: T }
  | { ok: false; errors: string[] };

const SCHEMAS = {
  [METRICS_SCHEMA_ID]: {
    write: metricsEntrySchema,
    read: metricsEntryReadSchema,
  },
  [AUDIT_SCHEMA_ID]: {
    write: measurementAuditSchema,
    read: measurementAuditReadSchema,
  },
} as const;

/** Picks the schema by the entry's own `schema` id, so one call covers registry entries and audit reports. */
export function validateEntry(
  input: unknown,
  mode: Mode
): ValidateResult<
  MetricsEntry | MeasurementAudit | MetricsEntryRead | MeasurementAuditRead
> {
  const id =
    typeof input === "object" && input !== null
      ? (input as { schema?: unknown }).schema
      : undefined;
  const schemas =
    typeof id === "string" && id in SCHEMAS
      ? SCHEMAS[id as keyof typeof SCHEMAS]
      : undefined;
  if (!schemas)
    return {
      ok: false,
      errors: [`schema: expected ${METRICS_SCHEMA_ID} or ${AUDIT_SCHEMA_ID}`],
    };
  const parsed = schemas[mode].safeParse(input);
  if (parsed.success) return { ok: true, entry: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
    ),
  };
}
