/** Stored error text is evidence; this bounds it and strips credentials a subprocess might echo. */
export const MAX_STORED_ERROR_CHARS = 500;
export const REDACTED = "[redacted]";

// A token may follow a non-word character, `_` (KEY_sk-…), or an escape that ends in a word
// character: \n, \u0022, %22 or an ANSI colour or erase code. Requiring this, rather than any
// boundary, keeps words like risk-assessment-… and task-sk-… from reading as keys.
const ESCAPE = String.raw`\\[nrt]|\\u[0-9A-Fa-f]{4}|%[0-9A-Fa-f]{2}|\x1b\[[0-9;]{0,16}[A-Za-z]`;
const AFTER = String.raw`(?:(?<![A-Za-z0-9-])|(?<=${ESCAPE}))`;
// `_` is in the JWT class and the JWT needs dots after its first run, so a start after `_` or `-`
// would rescan that run from every eyJ inside it.
const AFTER_NON_JWT = String.raw`(?:(?<![\w-])|(?<=${ESCAPE}))`;
// Length floors keep npm_config_* env names and ids like task-sk-123 out; the `_` in npm_config falls outside the class.
const TOKEN = new RegExp(
  [
    String.raw`${AFTER}(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)`,
    String.raw`${AFTER}npm_[A-Za-z0-9]{30,}`,
    String.raw`${AFTER}sk-[A-Za-z0-9_-]{20,}`,
    String.raw`${AFTER_NON_JWT}eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+`,
  ].join("|"),
  "g",
);
const AUTHORIZATION = /(authorization\s*:\s*)(?:(?:bearer|token|basic)\s+)?\S+/gi;
// The password runs to its last `@` before a `/`, so an unencoded `@` in it is still scrubbed. A raw
// `/` is not: host:port/path@x would then read as userinfo. It also stops at a query, fragment or
// quote, so host:port?email=a@b and compact JSON keep their fields. `:\/\/` is the JSON-escaped form.
// The user may be empty, as in redis://:password@host. The scheme cap keeps a long dotted word from
// making the scan quadratic; user and password need none, since each scan stops at the next `://`.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:(?:\\?\/){2})[^\s/@:]*:[^\s/?#"']+@/gi;

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
