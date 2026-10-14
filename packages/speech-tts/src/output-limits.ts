/** The most engine output read into memory per call, unless a provider sets `maxOutputBytes`. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The most stderr or error body quoted in an error message. */
export const ERROR_TEXT_CHARS = 2_000;

/** Short values are left alone: redacting "en" or "1" would mangle every message. */
const MIN_SECRET_CHARS = 4;

/** Replaces every occurrence of each secret, longest first so one secret inside another is still covered. */
export function redact(text: string, secrets: readonly string[] = []): string {
  return [...secrets]
    .filter((s) => s.length >= MIN_SECRET_CHARS)
    .sort((a, b) => b.length - a.length)
    .reduce((out, secret) => out.replaceAll(secret, "[redacted]"), text);
}

/** Redacts before cutting, so a cut can never leave half a secret behind. */
export function errorText(raw: string, secrets: readonly string[] | undefined, keep: "head" | "tail"): string {
  const clean = redact(raw, secrets).trim();
  if (clean.length <= ERROR_TEXT_CHARS) return clean;
  return keep === "head" ? `${clean.slice(0, ERROR_TEXT_CHARS)}…` : `…${clean.slice(-ERROR_TEXT_CHARS)}`;
}
