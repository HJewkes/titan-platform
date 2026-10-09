import { z } from "zod";

// The status-line document Claude Code's session-budget writer stores per session: epoch
// seconds throughout, and a percentage per rate-limit window.
const windowSchema = z.object({
  used_percentage: z.number().nonnegative(),
  resets_at: z.number().positive().optional(),
});

const usageReadingSchema = z.object({
  session_id: z.string().min(1),
  written_at: z.number().int().positive(),
  rate_limits: z.record(z.string(), windowSchema),
  source: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
});

export type UsageWindow = z.infer<typeof windowSchema>;
export type UsageReading = z.infer<typeof usageReadingSchema>;

export const POLL_SESSION_ID = "usage-poll";
export const POLL_SOURCE = "oauth-usage";

export function parseUsageReading(input: unknown): UsageReading | null {
  const parsed = usageReadingSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
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

export function usageFromOAuthResponse(body: unknown, options: OAuthUsageOptions): UsageReading | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const rateLimits: Record<string, UsageWindow> = {};
  for (const [name, value] of Object.entries(body)) {
    if (!WINDOW_NAME.test(name)) continue;
    const window = windowFromOAuth(value);
    if (window) rateLimits[name] = window;
  }
  if (Object.keys(rateLimits).length === 0) return null;
  return parseUsageReading({
    session_id: POLL_SESSION_ID,
    written_at: options.writtenAt,
    rate_limits: rateLimits,
    source: POLL_SOURCE,
    account: options.account,
  });
}
