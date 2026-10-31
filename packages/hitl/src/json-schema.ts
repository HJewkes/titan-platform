/**
 * A deliberately small structural check over the JSON Schema subset `z.toJSONSchema`
 * emits. It exists so the process that resolves a gate can reject a bad payload
 * without holding the original zod schema, which by definition lives in another
 * process. The waiter still re-validates with the real zod schema, so this is the
 * boundary check, not the type guarantee.
 *
 * A stored schema is parsed once into a `SchemaNode`, and `parseSchema` is the only
 * reader of the raw value. Whatever it cannot read, an unknown keyword included,
 * becomes the one refusal below, so no value can pass as an open schema by being
 * misread. The checker walks typed nodes and has no malformed case of its own.
 */
export function checkAgainstJsonSchema(schema: unknown, value: unknown, path = "$"): string[] {
  const issues: string[] = [];
  try {
    collect(parseSchema(schema, "#"), value, path, issues);
  } catch (error) {
    return [`${path}: schema is unreadable: ${error instanceof Error ? error.message : String(error)}`];
  }
  return issues;
}

type ScalarType = "string" | "number" | "integer" | "boolean" | "null";
type SchemaType = ScalarType | "object" | "array";

type Shape =
  | { type: ScalarType }
  | { type: "object"; properties: Record<string, SchemaNode>; required: readonly string[]; closed: boolean }
  /** `items` governs only the elements after the tuple's `prefixItems`. */
  | { type: "array"; items: SchemaNode | undefined; prefixLength: number };

type SchemaNode =
  /** The boolean schema `false`: no value fits. zod writes it as `items: false` on every closed tuple. */
  | { kind: "never" }
  /** `anyOf`, else `oneOf`, read in place of its siblings: factory gates spell each answer shape in full there. */
  | { kind: "union"; branches: readonly SchemaNode[] }
  | { kind: "constrained"; pinned: { value: unknown } | undefined; allowed: readonly unknown[] | undefined; shape: Shape | undefined };

const OPEN: SchemaNode = { kind: "constrained", pinned: undefined, allowed: undefined, shape: undefined };
const NEVER: SchemaNode = { kind: "never" };

const SCHEMA_TYPES: ReadonlySet<unknown> = new Set<SchemaType>(["object", "array", "string", "number", "integer", "boolean", "null"]);

const ENFORCED = new Set(["anyOf", "oneOf", "const", "enum", "type", "properties", "required", "additionalProperties", "items", "prefixItems"]);

/** The JSON Schema annotation vocabulary plus zod's value refinements. Their values are never read, so none can misread a schema. */
const ANNOTATIONS = [
  "$schema", "$id", "$anchor", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly",
  "format", "contentEncoding", "contentMediaType", "contentSchema", "pattern", "minLength", "maxLength",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems",
];

/**
 * Keywords this check does not enforce, as it never has: annotations, value refinements and
 * composition all stay with the waiter's zod schema. They are listed so that a gate zod built
 * stays answerable, and subschemas among them must still parse. An `x-` key is an extension
 * annotation by convention, and `.meta()` is how one reaches a stored schema.
 */
const UNENFORCED = new Map<string, (value: unknown, at: string) => unknown>([
  ...ANNOTATIONS.map((keyword) => [keyword, () => undefined] as const),
  ["allOf", parseSchemaList],
  ["not", parseSchema],
  ["propertyNames", parseSchema],
  ["$defs", parseSchemaMap],
  ["$ref", parseReference],
]);

function parseSchema(raw: unknown, at: string): SchemaNode {
  if (raw === true) return OPEN;
  if (raw === false) return NEVER;
  if (!isPlainObject(raw)) throw new Error(`${at}: expected a schema`);
  for (const [keyword, value] of Object.entries(raw)) {
    if (ENFORCED.has(keyword)) continue;
    if (keyword.startsWith("x-")) continue;
    const parse = UNENFORCED.get(keyword);
    if (!parse) throw new Error(`${at}: unknown keyword ${keyword}`);
    parse(value, `${at}/${keyword}`);
  }
  return parseEnforced(raw, at);
}

/** Every enforced keyword parses even where another wins, so a schema is readable whole or not at all. */
function parseEnforced(raw: Record<string, unknown>, at: string): SchemaNode {
  const anyOf = present(raw.anyOf, `${at}/anyOf`, parseSchemaList);
  const oneOf = present(raw.oneOf, `${at}/oneOf`, parseSchemaList);
  const allowed = present(raw.enum, `${at}/enum`, parseList);
  const shape = parseShape(raw, at);
  const branches = anyOf ?? oneOf;
  if (branches) return { kind: "union", branches };
  return { kind: "constrained", pinned: Object.hasOwn(raw, "const") ? { value: raw.const } : undefined, allowed, shape };
}

function parseShape(raw: Record<string, unknown>, at: string): Shape | undefined {
  const properties = present(raw.properties, `${at}/properties`, parseSchemaMap) ?? {};
  const required = present(raw.required, `${at}/required`, parseNames) ?? [];
  const additional = present(raw.additionalProperties, `${at}/additionalProperties`, parseSchema);
  const items = present(raw.items, `${at}/items`, parseSchema);
  const prefix = present(raw.prefixItems, `${at}/prefixItems`, parseSchemaList) ?? [];
  const type = parseType(raw.type, `${at}/type`);
  if (type === undefined) return undefined;
  if (type === "object") return { type, properties, required, closed: additional === NEVER };
  if (type === "array") return { type, items, prefixLength: prefix.length };
  return { type };
}

/** A list of types stays unenforced, as it always was: zod writes `.nullable()` and primitive unions this way. */
function parseType(raw: unknown, at: string): SchemaType | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw) && raw.every(isSchemaType)) return undefined;
  if (isSchemaType(raw)) return raw;
  throw new Error(`${at}: expected a type name`);
}

function isSchemaType(raw: unknown): raw is SchemaType {
  return SCHEMA_TYPES.has(raw);
}

function present<T>(raw: unknown, at: string, parse: (value: unknown, at: string) => T): T | undefined {
  return raw === undefined ? undefined : parse(raw, at);
}

function parseSchemaList(raw: unknown, at: string): SchemaNode[] {
  return parseList(raw, at).map((entry, index) => parseSchema(entry, `${at}/${index}`));
}

function parseSchemaMap(raw: unknown, at: string): Record<string, SchemaNode> {
  if (!isPlainObject(raw)) throw new Error(`${at}: expected a map of schemas`);
  return Object.fromEntries(Object.entries(raw).map(([key, entry]) => [key, parseSchema(entry, `${at}/${key}`)]));
}

function parseNames(raw: unknown, at: string): string[] {
  const names = parseList(raw, at);
  if (!names.every((name) => typeof name === "string")) throw new Error(`${at}: expected property names`);
  return names;
}

function parseReference(raw: unknown, at: string): void {
  if (typeof raw !== "string") throw new Error(`${at}: expected a reference`);
}

function parseList(raw: unknown, at: string): unknown[] {
  if (!Array.isArray(raw)) throw new Error(`${at}: expected a list`);
  return raw;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) return false;
  const prototype: unknown = Object.getPrototypeOf(raw);
  return prototype === Object.prototype || prototype === null;
}

function collect(node: SchemaNode, value: unknown, path: string, issues: string[]): void {
  switch (node.kind) {
    case "never":
      issues.push(`${path}: no value is allowed`);
      return;
    case "union":
      checkUnion(node.branches, value, path, issues);
      return;
    case "constrained":
      checkConstrained(node, value, path, issues);
  }
}

function checkUnion(branches: readonly SchemaNode[], value: unknown, path: string, issues: string[]): void {
  const matched = branches.some((branch) => {
    const branchIssues: string[] = [];
    collect(branch, value, path, branchIssues);
    return branchIssues.length === 0;
  });
  if (!matched) issues.push(`${path}: matched none of the ${branches.length} allowed shapes`);
}

function checkConstrained(node: Extract<SchemaNode, { kind: "constrained" }>, value: unknown, path: string, issues: string[]): void {
  if (node.pinned && !Object.is(node.pinned.value, value)) {
    issues.push(`${path}: expected ${JSON.stringify(node.pinned.value)}`);
    return;
  }
  if (node.allowed && !node.allowed.some((option) => Object.is(option, value))) {
    issues.push(`${path}: expected one of ${JSON.stringify(node.allowed)}`);
    return;
  }
  if (node.shape) checkShape(node.shape, value, path, issues);
}

function checkShape(shape: Shape, value: unknown, path: string, issues: string[]): void {
  if (shape.type === "object" && isObjectValue(value)) {
    checkObject(shape, value, path, issues);
  } else if (shape.type === "array" && Array.isArray(value)) {
    checkArray(shape, value, path, issues);
  } else if (!matchesScalar(shape.type, value)) {
    issues.push(`${path}: expected ${shape.type}, received ${describe(value)}`);
  }
}

function checkObject(shape: Extract<Shape, { type: "object" }>, value: Record<string, unknown>, path: string, issues: string[]): void {
  for (const key of shape.required) {
    if (!(key in value)) issues.push(`${path}.${key}: required`);
  }
  if (shape.closed) {
    for (const key of Object.keys(value)) {
      if (!(key in shape.properties)) issues.push(`${path}.${key}: unexpected property`);
    }
  }
  for (const [key, sub] of Object.entries(shape.properties)) {
    if (key in value) collect(sub, value[key], `${path}.${key}`, issues);
  }
}

function checkArray(shape: Extract<Shape, { type: "array" }>, value: readonly unknown[], path: string, issues: string[]): void {
  const { items, prefixLength } = shape;
  if (!items) return;
  value.slice(prefixLength).forEach((entry, index) => collect(items, entry, `${path}[${index + prefixLength}]`, issues));
}

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesScalar(type: SchemaType, value: unknown): boolean {
  switch (type) {
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    case "string":
    case "boolean":
      return typeof value === type;
    default:
      return false;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
