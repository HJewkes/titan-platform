import type { JsonSchema } from "./types.js";

/**
 * A deliberately small structural check over the JSON Schema subset `z.toJSONSchema`
 * emits. It exists so the process that resolves a gate can reject a bad payload
 * without holding the original zod schema, which by definition lives in another
 * process. The waiter still re-validates with the real zod schema, so this is the
 * boundary check, not the type guarantee.
 */
export function checkAgainstJsonSchema(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const issues: string[] = [];
  collect(schema, value, path, issues);
  return issues;
}

function collect(schema: JsonSchema, value: unknown, path: string, issues: string[]): void {
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    checkUnion((schema.anyOf ?? schema.oneOf) as JsonSchema[], value, path, issues);
    return;
  }
  if ("const" in schema && !Object.is(schema.const, value)) {
    issues.push(`${path}: expected ${JSON.stringify(schema.const)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => Object.is(option, value))) {
    issues.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`);
    return;
  }
  if (typeof schema.type !== "string") return;
  if (!matchesType(schema.type, value)) {
    issues.push(`${path}: expected ${schema.type}, received ${describe(value)}`);
    return;
  }
  if (schema.type === "object") checkObject(schema, value as Record<string, unknown>, path, issues);
  if (schema.type === "array") checkArray(schema, value as unknown[], path, issues);
}

function checkUnion(branches: JsonSchema[], value: unknown, path: string, issues: string[]): void {
  const matched = branches.some((branch) => checkAgainstJsonSchema(branch, value, path).length === 0);
  if (!matched) issues.push(`${path}: matched none of the ${branches.length} allowed shapes`);
}

function checkObject(schema: JsonSchema, value: Record<string, unknown>, path: string, issues: string[]): void {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  for (const key of (schema.required ?? []) as string[]) {
    if (!(key in value)) issues.push(`${path}.${key}: required`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) issues.push(`${path}.${key}: unexpected property`);
    }
  }
  for (const [key, sub] of Object.entries(properties)) {
    if (key in value) collect(sub, value[key], `${path}.${key}`, issues);
  }
}

function checkArray(schema: JsonSchema, value: unknown[], path: string, issues: string[]): void {
  const items = schema.items as JsonSchema | undefined;
  if (!items) return;
  value.forEach((entry, index) => collect(items, entry, `${path}[${index}]`, issues));
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    default:
      return typeof value === type;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
