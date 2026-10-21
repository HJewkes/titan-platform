/** GitHub sends it on every answer to a token that expires; a token with no expiry gets none. */
const TOKEN_EXPIRATION_HEADER = "github-authentication-token-expiration";

const DAY_MS = 24 * 60 * 60 * 1000;
const ALARM_DAYS = 14;
const FINGERPRINT_SHOWN = 12;

/** GitHub writes `2026-11-04 12:00:00 UTC` or `2026-11-04 04:00:00 -0800`, neither of which is ISO. */
const EXPIRATION = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/;

export function parseTokenExpiration(header: string): number | undefined {
  const match = EXPIRATION.exec(header.trim());
  if (!match) return undefined;
  const [, date, time, zone = ""] = match;
  const offset = zone === "UTC" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const at = Date.parse(`${date}T${time}${offset}`);
  return Number.isNaN(at) ? undefined : at;
}

/**
 * Fingerprints already alarmed in this process. Shared by every watch, so a second identity opened over the same token
 * stays quiet; a restart raises it once more, which repeats the reminder at most once per deploy.
 */
const ALARMED = new Set<string>();

interface BotTokenExpiryWatch {
  /** Fed every bot response's headers, error answers included. */
  observe(headers: Headers): void;
  /** ISO time from the last header seen; null before any, or for a token with no expiry. */
  expiresAt(): string | null;
}

interface BotTokenExpiryOptions {
  fingerprint: string;
  now?: () => number;
  log?: (line: string) => void;
  alarmed?: Set<string>;
}

/** Keyed by the A17 fingerprint, never the token, so the alarm line names a token without holding it. */
export function botTokenExpiryWatch({ fingerprint, now = Date.now, log = console.error, alarmed = ALARMED }: BotTokenExpiryOptions): BotTokenExpiryWatch {
  let expiresAt: number | undefined;
  return {
    observe(headers) {
      const header = headers.get(TOKEN_EXPIRATION_HEADER);
      const at = header === null ? undefined : parseTokenExpiration(header);
      if (at === undefined) return;
      expiresAt = at;
      const daysLeft = Math.ceil((at - now()) / DAY_MS);
      if (daysLeft > ALARM_DAYS || alarmed.has(fingerprint)) return;
      alarmed.add(fingerprint);
      log(`factory: ops-alarm bot-token-expiry fingerprint=${fingerprint.slice(0, FINGERPRINT_SHOWN)} expiresAt=${new Date(at).toISOString()} daysLeft=${daysLeft}`);
    },
    expiresAt: () => (expiresAt === undefined ? null : new Date(expiresAt).toISOString()),
  };
}

/** The bot client's fetch, seen through: every answer's headers reach the watch before octokit reads the body. With no fetch given, the global one is looked up per call, as octokit itself does. */
export function observingFetch(inner: typeof globalThis.fetch | undefined, observe: (headers: Headers) => void): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await (inner ?? globalThis.fetch)(input, init);
    observe(response.headers);
    return response;
  };
}
