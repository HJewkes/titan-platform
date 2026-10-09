import { z } from "zod";

/** health/v1 follows draft-inadarei-api-health-check, an open format, so other readers can consume it unchanged. */
export const HEALTH_STATUSES = ["pass", "warn", "fail"] as const;
export const healthStatusSchema = z.enum(HEALTH_STATUSES);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

const SEVERITY: Record<HealthStatus, number> = { pass: 0, warn: 1, fail: 2 };

export function worstStatus(statuses: Iterable<HealthStatus>): HealthStatus {
  let worst: HealthStatus = "pass";
  for (const status of statuses) if (SEVERITY[status] > SEVERITY[worst]) worst = status;
  return worst;
}

// The write and read schemas share these, so they cannot disagree about a field's type; they
// differ only in how status and checks are taken.
const checkFields = {
  componentId: z.string().optional(),
  componentType: z.string().optional(),
  observedValue: z.unknown().optional(),
  observedUnit: z.string().optional(),
  output: z.string().optional(),
  time: z.string().optional(),
};

const reportFields = {
  started_at: z.string().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
  ok: z.boolean().optional(),
  version: z.string().optional(),
  pid: z.number().int().optional(),
  uptime_ms: z.number().nonnegative().optional(),
  port: z.number().int().optional(),
};

export const healthCheckSchema = z.looseObject({ status: healthStatusSchema, ...checkFields });
export type HealthCheck = z.infer<typeof healthCheckSchema>;

// The draft keys checks as "component:measurement", each holding one entry per node or instance.
// Loose so products keep their extension keys (runs, build, lastDeploy, ...) on the same payload.
const reportShape = z.looseObject({
  status: healthStatusSchema,
  checks: z.record(z.string(), z.array(healthCheckSchema)).optional(),
  ...reportFields,
});

/** The write schema: what a producer must emit. Its status may not be better than its worst check. */
export const healthReportSchema = reportShape.refine(
  (report) => SEVERITY[report.status] >= SEVERITY[worstStatus(checkStatuses(report.checks))],
  { message: "status is better than the worst of checks", path: ["status"] },
);
export type HealthReport = z.infer<typeof healthReportSchema>;

// The draft names these aliases for older producers.
const STATUS_ALIASES: Record<string, HealthStatus> = { ok: "pass", up: "pass", error: "fail", down: "fail" };

function readStatus(value: unknown): HealthStatus | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = healthStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : STATUS_ALIASES[value];
}

// A check status this reader does not know stays visible as warn without reading as down.
const checkReadSchema = z.looseObject({
  status: z.preprocess((raw) => readStatus(raw) ?? "warn", healthStatusSchema),
  ...checkFields,
});
const checksReadSchema = z.record(z.string(), z.array(checkReadSchema));

/** The read schema. Its output type is what `parseHealthReport` returns, with no cast in between. */
const healthReportReadSchema = z.looseObject({
  status: healthStatusSchema,
  checks: checksReadSchema.optional(),
  ...reportFields,
});
export type HealthReportReading = z.output<typeof healthReportReadSchema>;

/** `ignored` names, by dotted path, the fields the reader dropped because their type was wrong. */
export type HealthReportRead =
  | { ok: true; report: HealthReportReading; ignored: string[] }
  | { ok: false; error: string };

function checkStatuses(checks: Record<string, { status: HealthStatus }[]> | undefined): HealthStatus[] {
  return Object.values(checks ?? {}).flatMap((entries) => entries.map((check) => check.status));
}

function readOwnStatus(raw: Record<string, unknown>): HealthStatus | undefined {
  const status = readStatus(raw.status);
  if (status) return status;
  return typeof raw.ok === "boolean" ? (raw.ok ? "pass" : "fail") : undefined;
}

// Shapes the raw checks before parsing, so every issue path names a place in the input: a bare
// object where the draft puts an array is one entry, and an entry that is not an object reads as warn.
function normalizeChecks(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const checks: Record<string, unknown[]> = {};
  for (const [name, entries] of Object.entries(raw)) {
    checks[name] = (Array.isArray(entries) ? entries : [entries]).map((entry) => (isRecord(entry) ? entry : {}));
  }
  return checks;
}

function childAt(node: unknown, key: PropertyKey): unknown {
  if (Array.isArray(node) && typeof key === "number") return node[key];
  return isRecord(node) && typeof key === "string" ? node[key] : undefined;
}

function deletePath(target: unknown, path: PropertyKey[]): void {
  const parent = path.slice(0, -1).reduce(childAt, target);
  const last = path.at(-1);
  if (isRecord(parent) && typeof last === "string") delete parent[last];
}

/**
 * The read side: takes any payload a health route answered with. Only a status (or a legacy
 * boolean `ok`) is required. Unknown fields are kept, a mistyped known field at any depth is
 * dropped and named in `ignored`, and the status never reads better than a check.
 */
export function parseHealthReport(payload: unknown): HealthReportRead {
  if (!isRecord(payload)) return { ok: false, error: "health payload is not a JSON object" };
  const own = readOwnStatus(payload);
  if (!own) return { ok: false, error: "health payload has neither a status nor a boolean ok" };
  const input: Record<string, unknown> = { ...structuredClone(payload), status: own };
  if ("checks" in input) input.checks = normalizeChecks(input.checks);
  const first = healthReportReadSchema.safeParse(input);
  const issues = first.success ? [] : first.error.issues;
  for (const issue of issues) deletePath(input, issue.path);
  const read = first.success ? first : healthReportReadSchema.safeParse(input);
  if (!read.success) return { ok: false, error: z.prettifyError(read.error) };
  const status = worstStatus([read.data.status, ...checkStatuses(read.data.checks)]);
  return { ok: true, report: { ...read.data, status }, ignored: issues.map((issue) => issue.path.join(".")) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
