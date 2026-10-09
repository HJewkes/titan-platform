export const REDACTED = "[REDACTED]";

// Order matters: specific shapes go first so a later, broader pattern never leaves a tail
// of a token behind.
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/sk-ant-[A-Za-z0-9_-]+/g, REDACTED],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, REDACTED],
  [/\b(Bearer|Basic)\s+[^\s"',;]+/gi, `$1 ${REDACTED}`],
  [
    /\b(access_?token|refresh_?token|authorization|api_?key|x-api-key)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
    `$1$2${REDACTED}`,
  ],
  [/[A-Za-z0-9_-]{32,}/g, REDACTED],
];

function redactText(text: string): string {
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

function redactError(error: Error): Error {
  const copy = new Error(redactText(error.message));
  copy.name = redactText(error.name);
  if (typeof error.stack === "string") copy.stack = redactText(error.stack);
  return copy;
}

// An Error comes back as a fresh Error with no cause, so nothing the original carried
// beyond its redacted message, name and stack survives.
export function redactSecrets(value: string): string;
export function redactSecrets(value: Error): Error;
export function redactSecrets(value: string | Error): string | Error {
  return typeof value === "string" ? redactText(value) : redactError(value);
}
