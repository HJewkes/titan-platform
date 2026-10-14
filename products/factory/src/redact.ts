/** Stored error text is evidence; this bounds it and strips credentials a subprocess might echo. */
export const MAX_STORED_ERROR_CHARS = 500;
export const REDACTED = "[redacted]";

// Length floors keep npm_config_* env names and ids like task-sk-123 out; the `_` in npm_config falls outside the class.
const TOKEN = new RegExp(
  [
    String.raw`\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)`,
    String.raw`\bnpm_[A-Za-z0-9]{30,}`,
    String.raw`(?<![\w-])sk-[A-Za-z0-9_-]{20,}`,
    String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+`,
  ].join("|"),
  "g",
);
const AUTHORIZATION = /(authorization\s*:\s*)(?:(?:bearer|token|basic)\s+)?\S+/gi;
// A valid URL percent-encodes any `/` or `@` in the password, so stopping at them is safe.
// The scheme length cap keeps a long dotted word from making the scan quadratic.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

/** Strips credentials without bounding length, for callers that keep a tail rather than a head. */
export function redactCredentials(text: string): string {
  return text
    .replace(AUTHORIZATION, `$1${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(TOKEN, REDACTED);
}

export function redactForEvidence(text: string): string {
  const redacted = redactCredentials(text);
  return redacted.length <= MAX_STORED_ERROR_CHARS ? redacted : `${redacted.slice(0, MAX_STORED_ERROR_CHARS)}… [truncated]`;
}
