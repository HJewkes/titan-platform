import { redactSecrets as redactShared } from "@titan-design/anthropic-account";

function text(value: string): string {
  return redactShared(value.replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]"));
}

/** Reuse Titan redaction, adding OpenAI key prefixes; no cause or extra fields survive. */
export function redactSecrets(value: string): string;
export function redactSecrets(value: Error): Error;
export function redactSecrets(value: string | Error): string | Error {
  if (typeof value === "string") return text(value);
  try {
    const shared = redactShared(value);
    const result = new Error(text(shared.message));
    result.name = text(shared.name);
    if (shared.stack) result.stack = text(shared.stack);
    return result;
  } catch {
    return new Error("[REDACTED]");
  }
}
