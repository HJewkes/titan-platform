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

export const healthCheckSchema = z.looseObject({
  status: healthStatusSchema,
  componentId: z.string().optional(),
  componentType: z.string().optional(),
  observedValue: z.unknown().optional(),
  observedUnit: z.string().optional(),
  output: z.string().optional(),
  time: z.string().optional(),
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;

// The draft keys checks as "component:measurement", each holding one entry per node or instance.
const checksSchema = z.record(z.string(), z.array(healthCheckSchema));
type Checks = z.infer<typeof checksSchema>;

// Every field but status and checks; the reader validates these one at a time and drops a mistyped one.
const optionalFields = {
  started_at: z.string().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
  ok: z.boolean().optional(),
  version: z.string().optional(),
  pid: z.number().int().optional(),
  uptime_ms: z.number().nonnegative().optional(),
  port: z.number().int().optional(),
};

// Loose so products keep their extension keys (runs, build, lastDeploy, ...) on the same payload.
const reportShape = z.looseObject({ status: healthStatusSchema, checks: checksSchema.optional(), ...optionalFields });

/** The write schema: what a producer must emit. Its status may not be better than its worst check. */
export const healthReportSchema = reportShape.refine(
  (report) => SEVERITY[report.status] >= SEVERITY[worstStatus(checkStatuses(report.checks))],
  { message: "status is better than the worst of checks", path: ["status"] },
);
export type HealthReport = z.infer<typeof healthReportSchema>;

/** `ignored` names the known fields the reader dropped because their type was wrong. */
export type HealthReportRead = { ok: true; report: HealthReport; ignored: string[] } | { ok: false; error: string };

function checkStatuses(checks: Checks | undefined): HealthStatus[] {
  return Object.values(checks ?? {}).flatMap((entries) => entries.map((check) => check.status));
}

// The draft names these aliases for older producers.
const STATUS_ALIASES: Record<string, HealthStatus> = { ok: "pass", up: "pass", error: "fail", down: "fail" };

function readStatus(value: unknown): HealthStatus | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = healthStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : STATUS_ALIASES[value];
}

// Only the status is coerced, so observed values and outputs survive whatever their type. A status
// this reader does not know stays visible without reading as down.
function readCheck(raw: unknown): HealthCheck {
  const fields = isRecord(raw) ? raw : {};
  return { ...fields, status: readStatus(fields.status) ?? "warn" } as HealthCheck;
}

// A bare object where the draft puts an array is read as a one-entry array rather than lost.
function readChecks(raw: unknown): Checks | undefined {
  if (!isRecord(raw)) return undefined;
  const checks: Checks = {};
  for (const [name, entries] of Object.entries(raw)) {
    checks[name] = (Array.isArray(entries) ? entries : [entries]).map(readCheck);
  }
  return checks;
}

function readOwnStatus(raw: Record<string, unknown>): HealthStatus | undefined {
  const status = readStatus(raw.status);
  if (status) return status;
  return typeof raw.ok === "boolean" ? (raw.ok ? "pass" : "fail") : undefined;
}

function dropMistyped(fields: Record<string, unknown>): string[] {
  const ignored: string[] = [];
  for (const [name, schema] of Object.entries(optionalFields)) {
    if (name in fields && !schema.safeParse(fields[name]).success) {
      delete fields[name];
      ignored.push(name);
    }
  }
  return ignored;
}

/**
 * The read side: takes any payload a health route answered with. Only a status (or a legacy
 * boolean `ok`) is required. Unknown fields are kept, a mistyped known field is dropped and named
 * in `ignored`, and the status never reads better than a check.
 */
export function parseHealthReport(payload: unknown): HealthReportRead {
  if (!isRecord(payload)) return { ok: false, error: "health payload is not a JSON object" };
  const own = readOwnStatus(payload);
  if (!own) return { ok: false, error: "health payload has neither a status nor a boolean ok" };
  const { checks: rawChecks, ...rest } = payload;
  const ignored = dropMistyped(rest);
  const checks = readChecks(rawChecks);
  if (rawChecks !== undefined && !checks) ignored.push("checks");
  const status = worstStatus([own, ...checkStatuses(checks)]);
  const report = { ...rest, status, ...(checks ? { checks } : {}) } as HealthReport;
  return { ok: true, report, ignored };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
