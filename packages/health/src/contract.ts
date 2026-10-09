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
  observedValue: z.unknown().optional(),
  observedUnit: z.string().optional(),
  output: z.string().optional(),
  time: z.string().optional(),
});
export type HealthCheck = z.infer<typeof healthCheckSchema>;

// Loose so products keep their extension keys (runs, build, lastDeploy, ...) on the same payload.
const reportShape = z.looseObject({
  status: healthStatusSchema,
  checks: z.record(z.string(), healthCheckSchema).optional(),
  started_at: z.string().optional(),
  metrics: z.record(z.string(), z.unknown()).optional(),
  ok: z.boolean().optional(),
  version: z.string().optional(),
  pid: z.number().int().optional(),
  uptime_ms: z.number().nonnegative().optional(),
  port: z.number().int().optional(),
});

/** The write schema: what a producer must emit. Its status may not be better than its worst check. */
export const healthReportSchema = reportShape.refine(
  (report) => SEVERITY[report.status] >= SEVERITY[worstStatus(checkStatuses(report.checks))],
  { message: "status is better than the worst of checks", path: ["status"] },
);
export type HealthReport = z.infer<typeof healthReportSchema>;

export type HealthReportRead = { ok: true; report: HealthReport } | { ok: false; error: string };

function checkStatuses(checks: Record<string, { status: HealthStatus }> | undefined): HealthStatus[] {
  return Object.values(checks ?? {}).map((check) => check.status);
}

// The draft names these aliases for older producers.
const STATUS_ALIASES: Record<string, HealthStatus> = { ok: "pass", up: "pass", error: "fail", down: "fail" };

function readStatus(value: unknown): HealthStatus | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = healthStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : STATUS_ALIASES[value];
}

// A check status from a newer producer that this reader does not know stays visible without reading as down.
function readChecks(raw: unknown): Record<string, HealthCheck> | undefined {
  if (!isRecord(raw)) return undefined;
  const checks: Record<string, HealthCheck> = {};
  for (const [name, check] of Object.entries(raw)) {
    const fields = isRecord(check) ? check : {};
    checks[name] = { ...fields, status: readStatus(fields.status) ?? "warn" };
  }
  return checks;
}

function readOwnStatus(raw: Record<string, unknown>): HealthStatus | undefined {
  const status = readStatus(raw.status);
  if (status) return status;
  return typeof raw.ok === "boolean" ? (raw.ok ? "pass" : "fail") : undefined;
}

/**
 * The read side: takes any payload a health route answered with. A legacy payload with only `ok`
 * maps to pass or fail, unknown fields are kept, and the status never reads better than a check.
 */
export function parseHealthReport(payload: unknown): HealthReportRead {
  if (!isRecord(payload)) return { ok: false, error: "health payload is not a JSON object" };
  const own = readOwnStatus(payload);
  if (!own) return { ok: false, error: "health payload has neither a status nor a boolean ok" };
  const checks = readChecks(payload.checks);
  const status = worstStatus([own, ...checkStatuses(checks)]);
  const parsed = healthReportSchema.safeParse({ ...payload, status, ...(checks ? { checks } : {}) });
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, report: parsed.data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
