import type { AnyCommand, CliMeta, CliOption } from "./types.js";
import { arrayElementKind, fieldSchema, isOptionalField, schemaKind, type SchemaKind } from "./zod-introspect.js";

/** `--ship-target` becomes `ship_target`, the snake_case key convention for args schemas. */
export function flagToKey(long: string): string {
  return long.replace(/^--/, "").replace(/-/g, "_");
}

/** commander camelCases long flag names, dropping the leading `--`. */
export function camelizeFlagKey(flagKey: string): string {
  return flagKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Read one option out of commander's parsed opts.
 *
 * commander stores `--no-thing` as `thing === false` and never defines `noThing`,
 * so a `--no-*` flag must be read back off its stem. The paired value flag must
 * ignore that `false`, or `--no-notes` would reach `--notes` as a boolean.
 */
export function readCommanderOption(opts: Record<string, unknown>, long: string): unknown {
  if (long.startsWith("--no-")) {
    const stem = camelizeFlagKey(flagToKey(`--${long.slice("--no-".length)}`));
    return opts[stem] === false ? true : undefined;
  }
  const flagKey = flagToKey(long);
  const value = opts[camelizeFlagKey(flagKey)] ?? opts[flagKey];
  return value === false ? undefined : value;
}

/**
 * Coerce a raw commander value to the type the schema implies. For an array field, `value` is
 * the list of raw strings a repeatable flag collected; each element is coerced by `elementKind`.
 */
export function coerceCliValue(value: unknown, kind: SchemaKind | undefined, elementKind?: SchemaKind): unknown {
  if (value === undefined) return undefined;
  if (kind === "boolean") return value === true || value === "true";
  if (kind === "number") {
    if (typeof value === "number") return value;
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (kind === "array") {
    const values = Array.isArray(value) ? value : [value];
    return values.map((v) => coerceCliValue(v, elementKind));
  }
  return value;
}

/** commander accumulator for a repeatable flag: each occurrence appends to the array. */
function appendOccurrence(value: string, previous: string[] | undefined): string[] {
  return previous ? [...previous, value] : [value];
}

/**
 * Commander's parser argument for a field's option, or undefined for a plain single-value flag.
 * An array-typed field needs this so repeated occurrences of its flag accumulate instead of
 * each overwriting the last (commander's default behavior for a same-named option).
 */
export function collectOptionParser(cmd: AnyCommand, key: string): ((value: string, previous: string[] | undefined) => string[]) | undefined {
  return schemaKind(fieldSchema(cmd.args, key)) === "array" ? appendOccurrence : undefined;
}

/** Assemble the raw args record from commander positionals and parsed opts, coerced per schema. */
export function collectCliArgs(
  cmd: AnyCommand,
  positionals: unknown[],
  opts: Record<string, unknown>,
): Record<string, unknown> {
  const meta: CliMeta = cmd.cli ?? {};
  const raw: Record<string, unknown> = {};
  (meta.positional ?? []).forEach((name, i) => {
    const value = positionals[i];
    if (value !== undefined) raw[name] = coerceCliValue(value, schemaKind(fieldSchema(cmd.args, name)));
  });
  for (const [key, opt] of Object.entries(meta.options ?? {})) {
    const value = readCommanderOption(opts, opt.long);
    if (value === undefined) continue;
    const schema = fieldSchema(cmd.args, key);
    const kind = schemaKind(schema);
    raw[key] = coerceCliValue(value, kind, kind === "array" ? arrayElementKind(schema) : undefined);
  }
  return raw;
}

/** commander option spec: boolean fields are bare flags, everything else takes `<value>`. */
export function optionFlagSpec(cmd: AnyCommand, key: string, opt: CliOption): string {
  const short = opt.short ? `${opt.short}, ` : "";
  const kind = schemaKind(fieldSchema(cmd.args, key));
  return kind === "boolean" ? `${short}${opt.long}` : `${short}${opt.long} <value>`;
}

/** commander argument display: `[name]` when the schema allows omission, else `<name>`. */
export function positionalSpec(cmd: AnyCommand, name: string): string {
  return isOptionalField(fieldSchema(cmd.args, name)) ? `[${name}]` : `<${name}>`;
}

/** `task.add` becomes `["task", "add"]`: the commander sub-command path. */
export function commandPath(name: string): string[] {
  return name.split(".");
}
