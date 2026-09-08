import type { AnyCommand, CliMeta, CliOption } from "./types.js";
import { fieldSchema, isOptionalField, schemaKind, type SchemaKind } from "./zod-introspect.js";

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

/** Coerce a raw commander value (string | boolean | undefined) to the type the schema implies. */
export function coerceCliValue(value: unknown, kind: SchemaKind | undefined): unknown {
  if (value === undefined) return undefined;
  if (kind === "boolean") return value === true || value === "true";
  if (kind === "number") {
    if (typeof value === "number") return value;
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (kind === "array") {
    if (Array.isArray(value)) return value;
    return String(value)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return value;
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
    if (value !== undefined) raw[key] = coerceCliValue(value, schemaKind(fieldSchema(cmd.args, key)));
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
