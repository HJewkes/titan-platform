const PLACEHOLDER = "[REDACTED]";

const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
// The optional quote after the name lets a JSON key such as "password": "x" match.
const KEY_VALUE = /\b([A-Za-z0-9_-]*(?:token|key|password))(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&"',;]+)/gi;
// Exactly 40 hex characters is a git commit SHA, which the owner exempted so git previews stay approvable.
const HEX_RUN = /\b(?:[0-9a-fA-F]{32,39}|[0-9a-fA-F]{41,})\b/g;
const B64_RUN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g;

const PLAIN_WORD = /^(?:[a-z]{3,}|[A-Z]{3,})$/;

/** A base64-like run is a secret only if it mixes digits and both cases and no path segment is a plain word. */
export function looksSecret(run: string): boolean {
  if (!/\d/.test(run) || !/[A-Z]/.test(run) || !/[a-z]/.test(run)) return false;
  return !run.split("/").some((segment) => PLAIN_WORD.test(segment));
}

/** Section 10 decision 3: masks auth headers, key=value secrets and long hex or base64 runs. */
export function redactPreview(text: string): { text: string; redacted: boolean } {
  let hits = 0;
  const hit = (replacement: string) => {
    hits += 1;
    return replacement;
  };
  const out = text
    .replace(AUTH_HEADER, (_match, scheme: string) => hit(`${scheme} ${PLACEHOLDER}`))
    .replace(KEY_VALUE, (_match, name: string, separator: string) => hit(`${name}${separator}${PLACEHOLDER}`))
    .replace(HEX_RUN, () => hit(PLACEHOLDER))
    .replace(B64_RUN, (run) => (looksSecret(run) ? hit(PLACEHOLDER) : run));
  return { text: out, redacted: hits > 0 };
}
