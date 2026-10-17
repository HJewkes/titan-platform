import { ZodLiteral, ZodOptional, type ZodType } from "zod";
import type { AnyCommand, CliMeta, CliOption } from "./types.js";
import { arrayElementKind, fieldSchema, isOptionalField, schemaDefault, schemaKind, unwrapSchema, type SchemaKind } from "./zod-introspect.js";

/** `--ship-target` becomes `ship_target`, the snake_case key convention for args schemas. */
export function flagToKey(long: string): string {
  return longFlagName(long).replace(/^--/, "").replace(/-/g, "_");
}

/** Reduce a commander flag spec such as `-s, --spawner <name>` to its bare long flag `--spawner`. */
function longFlagName(spec: string): string {
  const withoutPlaceholder = spec.replace(/\s+[<[].*$/, "");
  const parts = withoutPlaceholder.split(",").map((part) => part.trim());
  return parts.find((part) => part.startsWith("--")) ?? withoutPlaceholder.trim();
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
export function readCommanderOption(opts: Record<string, unknown>, spec: string): unknown {
  const long = longFlagName(spec);
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
export function collectOptionParser(cmd: AnyCommand<never>, key: string): ((value: string, previous: string[] | undefined) => string[]) | undefined {
  return schemaKind(fieldSchema(cmd.args, key)) === "array" ? appendOccurrence : undefined;
}

/** Assemble the raw args record from commander positionals and parsed opts, coerced per schema. */
export function collectCliArgs(
  cmd: AnyCommand<never>,
  positionals: unknown[],
  opts: Record<string, unknown>,
): Record<string, unknown> {
  const meta: CliMeta = cmd.cli ?? {};
  const raw: Record<string, unknown> = {};
  (meta.positional ?? []).forEach((name, i) => {
    const value = positionals[i];
    if (value !== undefined) {
      const schema = fieldSchema(cmd.args, name);
      raw[name] = coerceCliValue(value, schemaKind(schema), arrayElementKind(schema));
    }
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

/** Only an exact true literal, optionally wrapped, can be supplied by presence alone. */
function isTrueSwitch(schema: ZodType | undefined): boolean {
  if (!schema) return false;
  let optionalBase: object = schema;
  while (optionalBase instanceof ZodOptional) optionalBase = optionalBase.unwrap();
  const unwrapped = unwrapSchema(schema);
  return optionalBase === unwrapped && unwrapped instanceof ZodLiteral
    && unwrapped.def.values.length === 1 && unwrapped.def.values[0] === true;
}

/** Boolean fields and exact true switches are bare; other fields take a value. */
export function optionFlagSpec(cmd: AnyCommand<never>, key: string, opt: CliOption): string {
  const short = opt.short ? `${opt.short}, ` : "";
  const schema = fieldSchema(cmd.args, key);
  const kind = schemaKind(schema);
  return kind === "boolean" || isTrueSwitch(schema) ? `${short}${opt.long}` : `${short}${opt.long} <${opt.valueName ?? "value"}>`;
}

/** commander argument display: `[name]` when the schema allows omission, else `<name>`. */
export function positionalSpec(cmd: AnyCommand<never>, name: string): string {
  const schema = fieldSchema(cmd.args, name);
  const label = schemaKind(schema) === "array" ? `${name}...` : name;
  return isOptionalField(schema) ? `[${label}]` : `<${label}>`;
}

/** `task.add` becomes `["task", "add"]`: the commander sub-command path. */
export function commandPath(name: string): string[] {
  return name.split(".");
}

/** Explicit zod default for a command field, for the product's Commander option wiring. */
export function optionDefault(cmd: AnyCommand<never>, key: string): unknown {
  return schemaDefault(fieldSchema(cmd.args, key));
}
