import { EXIT, errorEnvelope, successEnvelope, type JsonEnvelope } from "@titan-design/rpc-protocol";

/**
 * The args exactly as a daemon would receive them: JSON round-tripped, with no args,
 * `undefined`, and `null` all meaning `{}` as they do in `POST /rpc/:name`.
 */
export function wireArgs(args: unknown): unknown {
  const text = JSON.stringify(args ?? {}) as string | undefined;
  return (text === undefined ? null : JSON.parse(text)) ?? {};
}

/** `wireArgs` as an envelope: args JSON cannot carry (a BigInt, a cycle) are `EXIT.DATAERR`, like any bad args. */
export function checkedWireArgs(args: unknown): JsonEnvelope<unknown> {
  try {
    return successEnvelope(wireArgs(args));
  } catch (err) {
    return errorEnvelope(`Args must be JSON-serialisable: ${err instanceof Error ? err.message : String(err)}`, EXIT.DATAERR);
  }
}

/** The wire args as JSON with every object's keys sorted, so equal args always print the same text. */
export function canonicalArgs(args: unknown): string {
  return JSON.stringify(sortKeys(wireArgs(args)));
}

/** The lookup key for one call in a snapshot: `["<command>",<canonical args>]`. */
export function snapshotKey(command: string, args: unknown): string {
  return `[${JSON.stringify(command)},${canonicalArgs(args)}]`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.keys(value)
    .sort()
    .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])] as const);
  // fromEntries defines own properties, so a "__proto__" key stays data instead of a prototype.
  return Object.fromEntries(entries);
}
