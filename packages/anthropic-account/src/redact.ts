export const REDACTED = "[REDACTED]";

// Order matters: specific shapes go first so a later, broader pattern never leaves a tail
// of a token behind.
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/sk-ant-[A-Za-z0-9_-]+/g, REDACTED],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, REDACTED],
  [/\b(Bearer|Basic)\s+(["']?)[^\s"',;]+\2/gi, `$1 $2${REDACTED}$2`],
  [
    /\b(access_?token|refresh_?token|id_?token|token|client_?secret|password|authorization|api_?key|x-api-key)(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\s)[^\s"',;}&]+/gi,
    `$1$2${REDACTED}`,
  ],
  [/[A-Za-z0-9_-]{32,}/g, REDACTED],
];

function redactText(text: string): string {
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

function copyRedacted(error: Error): Error {
  const { message, name, stack } = error;
  if (typeof message !== "string") return new Error(REDACTED);
  const copy = new Error(redactText(message));
  if (typeof name === "string") copy.name = redactText(name);
  if (typeof stack === "string") copy.stack = redactText(stack);
  return copy;
}

// A hostile message getter's exception could carry a token, so any failure to read the
// original gives a fixed Error instead of escaping.
function redactError(error: Error): Error {
  try {
    return copyRedacted(error);
  } catch {
    return new Error(REDACTED);
  }
}

// An Error comes back as a fresh Error with no cause, so nothing the original carried
// beyond its redacted message, name and stack survives. Redacting never throws.
export function redactSecrets(value: string): string;
export function redactSecrets(value: Error): Error;
export function redactSecrets(value: string | Error): string | Error {
  return typeof value === "string" ? redactText(value) : redactError(value);
}
