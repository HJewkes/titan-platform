import { z } from "zod";

// The status-line document Claude Code's session-budget writer stores per session: epoch
// seconds throughout, and a percentage per rate-limit window.
// Strict shapes for the two strings copied out of a response body, so nothing else in it can
// reach a reading.
const SEVERITY = /^[a-z0-9_]{1,20}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

const windowSchema = z.object({
  used_percentage: z.number().nonnegative(),
  resets_at: z.number().positive().optional(),
  severity: z.string().regex(SEVERITY).optional(),
});

const scopedSchema = z.object({
  model: z.string().regex(MODEL_NAME),
  used_pct: z.number().nonnegative(),
  severity: z.string().regex(SEVERITY).optional(),
});

// The usage API reports a window with no activity as null, and a copy of that body can reach a
// file; a null window is a valid absence, so it is dropped instead of costing the whole reading.
function withoutNulls(windows: Record<string, z.infer<typeof windowSchema> | null>): Record<string, z.infer<typeof windowSchema>> {
  const kept: Record<string, z.infer<typeof windowSchema>> = {};
  for (const [name, window] of Object.entries(windows)) if (window !== null) kept[name] = window;
  return kept;
}

const windowsSchema = z.record(z.string(), windowSchema.nullable()).transform(withoutNulls);

const usageReadingSchema = z.object({
  session_id: z.string().min(1),
  written_at: z.number().int().positive(),
  rate_limits: windowsSchema,
  scoped: scopedSchema.optional(),
  source: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
});

// A status line stamps its last API response's prompt cache beside rate_limits; that stamp is
// what dates its figures, since written_at changes on every redraw. A malformed stamp is dropped
// rather than costing the reading.
const promptCacheSchema = z.object({
  ttl: z.string().regex(/^\d{1,7}[smh]$/).optional(),
  expires_at: z.number().positive().optional(),
});

const observedReadingSchema = usageReadingSchema.extend({
  prompt_cache: promptCacheSchema.optional().catch(undefined),
});

export type UsageWindow = z.infer<typeof windowSchema>;
export type ScopedUsage = z.infer<typeof scopedSchema>;
export type UsageReading = z.infer<typeof usageReadingSchema>;
/** A stored reading, with the prompt-cache stamp a status line writes beside its rate_limits. */
export type ObservedReading = z.infer<typeof observedReadingSchema>;

export const POLL_SESSION_ID = "usage-poll";
export const POLL_SOURCE = "oauth-usage";

export function parseUsageReading(input: unknown): UsageReading | null {
  const parsed = usageReadingSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseObservedReading(input: unknown): ObservedReading | null {
  const parsed = observedReadingSchema.safeParse(input);
  if (!parsed.success) return null;
  const { prompt_cache, ...reading } = parsed.data;
  return prompt_cache === undefined ? reading : { ...reading, prompt_cache };
}

// Only short snake_case keys become window names, so nothing else in a response body,
// however it is shaped, can reach the returned reading.
const WINDOW_NAME = /^[a-z0-9_]{1,40}$/;

const oauthWindowSchema = z.object({
  utilization: z.number().nonnegative(),
  resets_at: z.string().nullable(),
});

export interface OAuthUsageOptions {
  writtenAt: number;
  account?: string;
}

function windowFromOAuth(value: unknown): UsageWindow | null {
  const parsed = oauthWindowSchema.safeParse(value);
  if (!parsed.success) return null;
  const resetsMs = parsed.data.resets_at === null ? Number.NaN : Date.parse(parsed.data.resets_at);
  const window: UsageWindow = { used_percentage: parsed.data.utilization };
  if (Number.isFinite(resetsMs) && resetsMs > 0) window.resets_at = Math.floor(resetsMs / 1000);
  return window;
}

function windowsFromOAuth(body: unknown): Record<string, UsageWindow> {
  const rateLimits: Record<string, UsageWindow> = {};
  if (typeof body !== "object" || body === null || Array.isArray(body)) return rateLimits;
  for (const [name, value] of Object.entries(body)) {
    if (!WINDOW_NAME.test(name)) continue;
    const window = windowFromOAuth(value);
    if (window) rateLimits[name] = window;
  }
  return rateLimits;
}

function safeWindowsFromOAuth(body: unknown): Record<string, UsageWindow> {
  try {
    return windowsFromOAuth(body);
  } catch {
    return {};
  }
}

const limitSchema = z.object({
  kind: z.string(),
  percent: z.number().nonnegative().optional(),
  severity: z.string().optional(),
  scope: z.object({ model: z.object({ display_name: z.string() }) }).optional(),
});

function limitsOf(body: unknown): z.infer<typeof limitSchema>[] {
  const list = typeof body === "object" && body !== null ? (body as { limits?: unknown }).limits : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const parsed = limitSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

interface LimitFigures {
  weeklySeverity: string | undefined;
  scoped: ScopedUsage | undefined;
}

// Kinds other than weekly_all and weekly_scoped are ignored, so a new kind cannot break a poll.
function limitFigures(body: unknown): LimitFigures {
  let limits: z.infer<typeof limitSchema>[];
  try {
    limits = limitsOf(body);
  } catch {
    limits = [];
  }
  const weeklySeverity = limits.find((limit) => limit.kind === "weekly_all")?.severity;
  const scopedLimit = limits.find((limit) => limit.kind === "weekly_scoped");
  const candidate = scopedLimit && {
    model: scopedLimit.scope?.model.display_name,
    used_pct: scopedLimit.percent,
    severity: scopedLimit.severity,
  };
  const scoped = scopedSchema.safeParse(candidate);
  return { weeklySeverity, scoped: scoped.success ? scoped.data : undefined };
}

function withWeeklySeverity(rateLimits: Record<string, UsageWindow>, severity: string | undefined): void {
  const weekly = rateLimits.seven_day;
  if (weekly && severity !== undefined && SEVERITY.test(severity)) weekly.severity = severity;
}

// A body whose getter throws gives null, because the exception could carry a token.
export function usageFromOAuthResponse(body: unknown, options: OAuthUsageOptions): UsageReading | null {
  const rateLimits = safeWindowsFromOAuth(body);
  if (Object.keys(rateLimits).length === 0) return null;
  const { weeklySeverity, scoped } = limitFigures(body);
  withWeeklySeverity(rateLimits, weeklySeverity);
  return parseUsageReading({
    session_id: POLL_SESSION_ID,
    written_at: options.writtenAt,
    rate_limits: rateLimits,
    ...(scoped && { scoped }),
    source: POLL_SOURCE,
    account: options.account,
  });
}
