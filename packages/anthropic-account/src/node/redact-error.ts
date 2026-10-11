import { redactSecrets } from "../redact.js";

// A thrown non-Error is not stringified, since its toString could carry a token or throw.
export function redactedError(error: unknown, fallback: string): Error {
  return error instanceof Error ? redactSecrets(error) : new Error(fallback);
}
