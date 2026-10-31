import type { JsonSchema } from "./types.js";

/**
 * A deliberately small structural check over the JSON Schema subset `z.toJSONSchema`
 * emits. It exists so the process that resolves a gate can reject a bad payload
 * without holding the original zod schema, which by definition lives in another
 * process. The waiter still re-validates with the real zod schema, so this is the
 * boundary check, not the type guarantee.
 */
export function checkAgainstJsonSchema(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const malformed = shapeIssues(schema, path);
  return malformed.length > 0 ? malformed : collectIssues(schema, value, path);
}

const MALFORMED = "schema is malformed";

/**
 * A stored schema is untrusted data, so its shape is judged once, before any check reads it: a schema is `true` or a
 * plain object, and a keyword this checker reads must hold the type it reads. Anything else refuses the resolve
 * rather than reading as an open schema.
 */
function shapeIssues(schema: unknown, path: string): string[] {
  if (schema === true) return [];
  if (!isObject(schema)) return [`${path}: ${MALFORMED}`];
  const issues: string[] = [];
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches = schema[keyword];
    if (branches === undefined) continue;
    if (Array.isArray(branches)) branches.forEach((branch) => issues.push(...shapeIssues(branch, path)));
    else issues.push(`${path}: ${MALFORMED}`);
  }
  if (schema.type !== undefined && typeof schema.type !== "string") issues.push(`${path}: ${MALFORMED}`);
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) issues.push(`${path}: ${MALFORMED}`);
  if (schema.required !== undefined && !isKeyList(schema.required)) issues.push(`${path}: ${MALFORMED}`);
  if (schema.items !== undefined) issues.push(...shapeIssues(schema.items, path));
  if (schema.properties !== undefined) issues.push(...propertyShapeIssues(schema.properties, path));
  return issues;
}

function propertyShapeIssues(properties: unknown, path: string): string[] {
  if (!isObject(properties)) return [`${path}: ${MALFORMED}`];
  return Object.entries(properties).flatMap(([key, sub]) => shapeIssues(sub, `${path}.${key}`));
}

function isKeyList(value: unknown): value is Array<string | number> {
  return Array.isArray(value) && value.every((key) => typeof key === "string" || typeof key === "number");
}

function collectIssues(schema: unknown, value: unknown, path: string): string[] {
  const issues: string[] = [];
  collect(schema, value, path, issues);
  return issues;
}

/** Reads a schema that `shapeIssues` has already accepted. */
function collect(schema: unknown, value: unknown, path: string, issues: string[]): void {
  if (!isObject(schema)) return;
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf;
  if (Array.isArray(branches)) {
    checkUnion(branches, value, path, issues);
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
  if (schema.type === "object" && isObject(value)) checkObject(schema, value, path, issues);
  if (schema.type === "array" && Array.isArray(value)) checkArray(schema, value, path, issues);
}

function checkUnion(branches: unknown[], value: unknown, path: string, issues: string[]): void {
  const matched = branches.some((branch) => collectIssues(branch, value, path).length === 0);
  if (!matched) issues.push(`${path}: matched none of the ${branches.length} allowed shapes`);
}

function checkObject(schema: JsonSchema, value: Record<string, unknown>, path: string, issues: string[]): void {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = isKeyList(schema.required) ? schema.required : [];
  for (const key of required) {
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
  const items: unknown = schema.items;
  if (items === undefined) return;
  value.forEach((entry, index) => collect(items, entry, `${path}[${index}]`, issues));
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isObject(value);
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
