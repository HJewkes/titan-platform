import { fail, nonempty, record } from "./lifecycle-validation.js";

/** `<prefix>.<name>`: a lowercase system prefix, then a name that may itself contain dots. */
export const CORRELATION_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9_.-]{0,63}$/;

/** Prefixes only their producer may write: `broker.*` for broker facts, `agent-thread.*` for thread links. */
export const RESERVED_CORRELATION_PREFIXES = ["broker", "agent-thread"] as const;

export const MAX_CORRELATIONS = 32;
export const MAX_CORRELATION_VALUE_LENGTH = 512;

export type ExecutionCorrelations = Readonly<Record<string, string>>;

export function correlationKey(prefix: string, name: string): string {
  const key = `${prefix}.${name}`;
  if (!CORRELATION_KEY_PATTERN.test(key)) throw new TypeError(`invalid correlation key ${JSON.stringify(key)}`);
  return key;
}

/** Returns a frozen copy, so neither the caller nor a later transition can change what prepare stored. */
export function validateCorrelations(correlations: unknown): ExecutionCorrelations {
  if (!record(correlations)) fail("invalid_transition", "correlations must be an object");
  const entries = Object.entries(correlations);
  if (entries.length > MAX_CORRELATIONS) fail("invalid_transition", `correlations may hold at most ${MAX_CORRELATIONS} keys`);
  for (const [key, value] of entries) {
    if (!CORRELATION_KEY_PATTERN.test(key)) fail("invalid_transition", `correlation key ${JSON.stringify(key)} must be <prefix>.<name>`);
    nonempty(`correlations[${key}]`, value);
    if (value.length > MAX_CORRELATION_VALUE_LENGTH) {
      fail("invalid_transition", `correlations[${key}] exceeds ${MAX_CORRELATION_VALUE_LENGTH} characters`);
    }
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}
