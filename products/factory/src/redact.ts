/** Stored error text is evidence; this bounds it and strips credentials a subprocess might echo. */
export const MAX_STORED_ERROR_CHARS = 500;
export const REDACTED = "[redacted]";

const TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g;
const AUTHORIZATION = /(authorization\s*:\s*)(?:(?:bearer|token|basic)\s+)?\S+/gi;

/** Strips credentials without bounding length, for callers that keep a tail rather than a head. */
export function redactCredentials(text: string): string {
  return text.replace(AUTHORIZATION, `$1${REDACTED}`).replace(TOKEN, REDACTED);
}

export function redactForEvidence(text: string): string {
  const redacted = redactCredentials(text);
  return redacted.length <= MAX_STORED_ERROR_CHARS ? redacted : `${redacted.slice(0, MAX_STORED_ERROR_CHARS)}… [truncated]`;
}
