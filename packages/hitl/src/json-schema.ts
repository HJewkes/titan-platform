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
    collect(readSchema(schema), value, path, issues);
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
  | { type: "array"; items: SchemaNode | undefined; prefix: readonly SchemaNode[] };

type SchemaNode =
  /** The boolean schema `false`: no value fits. zod writes it as `items: false` on every closed tuple. */
  | { kind: "never" }
  /** `anyOf`, else `oneOf`, read in place of its siblings: factory gates spell each answer shape in full there. */
  | { kind: "union"; branches: readonly SchemaNode[] }
  | { kind: "constrained"; pinned: { value: unknown } | undefined; allowed: readonly unknown[] | undefined; shape: Shape | undefined }
  /** A node's own keywords together with its `allOf` branches, `not` and `$ref`, all of which must hold. */
  | { kind: "all"; parts: readonly SchemaNode[] }
  | { kind: "not"; negated: SchemaNode }
  | { kind: "ref"; target: string; references: References };

/**
 * One stored schema's resolved local references, keyed by the reference as written. It is built
 * afresh for each check, so the expansion budget it carries is that check's alone: references let a
 * small schema expand exponentially (`allOf` of two references to the next definition, and so on).
 */
type References = { root: unknown; nodes: Map<string, SchemaNode>; expansionsLeft: number };

const OPEN: SchemaNode = { kind: "constrained", pinned: undefined, allowed: undefined, shape: undefined };
const NEVER: SchemaNode = { kind: "never" };
const REFERENCE_EXPANSIONS = 10_000;

const SCHEMA_TYPES: ReadonlySet<unknown> = new Set<SchemaType>(["object", "array", "string", "number", "integer", "boolean", "null"]);

const ENFORCED = new Set([
  "anyOf", "oneOf", "const", "enum", "type", "properties", "required", "additionalProperties", "items", "prefixItems", "allOf", "not", "$ref",
]);

/** The JSON Schema annotation vocabulary plus zod's value refinements. Their values are never read, so none can misread a schema. */
const ANNOTATIONS = [
  "$schema", "$id", "$anchor", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly",
  "format", "contentEncoding", "contentMediaType", "contentSchema", "pattern", "minLength", "maxLength",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems",
];

type Parse<T> = (value: unknown, at: string, references: References) => T;

/**
 * Keywords this check does not enforce, as it never has: annotations and value refinements stay
 * with the waiter's zod schema. They are listed so that a gate zod built stays answerable, and
 * subschemas among them must still parse. An `x-` key is an extension annotation by convention,
 * and `.meta()` is how one reaches a stored schema.
 */
const UNENFORCED = new Map<string, Parse<unknown>>([
  ...ANNOTATIONS.map((keyword) => [keyword, () => undefined] as const),
  ["propertyNames", parseSchema],
  ["$defs", parseSchemaMap],
  ["definitions", parseSchemaMap],
]);

/** The root is registered as `#` before it is read, so a recursive zod schema's `$ref: "#"` resolves without a second read. */
function readSchema(schema: unknown): SchemaNode {
  const references: References = { root: schema, nodes: new Map([["#", NEVER]]), expansionsLeft: REFERENCE_EXPANSIONS };
  const node = parseSchema(schema, "#", references);
  references.nodes.set("#", node);
  refuseReferenceCycles(references.nodes);
  return node;
}

function parseSchema(raw: unknown, at: string, references: References): SchemaNode {
  if (raw === true) return OPEN;
  if (raw === false) return NEVER;
  if (!isPlainObject(raw)) throw new Error(`${at}: expected a schema`);
  for (const [keyword, value] of Object.entries(raw)) {
    if (ENFORCED.has(keyword)) continue;
    if (keyword.startsWith("x-")) continue;
    const parse = UNENFORCED.get(keyword);
    if (!parse) throw new Error(`${at}: unknown keyword ${keyword}`);
    parse(value, `${at}/${keyword}`, references);
  }
  const own = parseEnforced(raw, at, references);
  const parts = [own, ...parseComposition(raw, at, references)];
  return parts.length === 1 ? own : { kind: "all", parts };
}

/** Every enforced keyword parses even where another wins, so a schema is readable whole or not at all. */
function parseEnforced(raw: Record<string, unknown>, at: string, references: References): SchemaNode {
  const anyOf = present(raw.anyOf, `${at}/anyOf`, references, parseSchemaList);
  const oneOf = present(raw.oneOf, `${at}/oneOf`, references, parseSchemaList);
  const allowed = present(raw.enum, `${at}/enum`, references, parseList);
  const shape = parseShape(raw, at, references);
  const branches = anyOf ?? oneOf;
  if (branches) return { kind: "union", branches };
  return { kind: "constrained", pinned: Object.hasOwn(raw, "const") ? { value: raw.const } : undefined, allowed, shape };
}

/** These hold beside a union too: `anyOf` stands in only for the keywords `parseEnforced` reads. */
function parseComposition(raw: Record<string, unknown>, at: string, references: References): SchemaNode[] {
  const allOf = present(raw.allOf, `${at}/allOf`, references, parseSchemaList) ?? [];
  const negated = present(raw.not, `${at}/not`, references, parseSchema);
  const reference = present(raw.$ref, `${at}/$ref`, references, parseReference);
  return [...allOf, ...(negated ? [{ kind: "not", negated } as const] : []), ...(reference ? [reference] : [])];
}

function parseShape(raw: Record<string, unknown>, at: string, references: References): Shape | undefined {
  const properties = present(raw.properties, `${at}/properties`, references, parseSchemaMap) ?? {};
  const required = present(raw.required, `${at}/required`, references, parseNames) ?? [];
  const additional = present(raw.additionalProperties, `${at}/additionalProperties`, references, parseSchema);
  const items = present(raw.items, `${at}/items`, references, parseSchema);
  const prefix = present(raw.prefixItems, `${at}/prefixItems`, references, parseSchemaList) ?? [];
  const type = parseType(raw.type, `${at}/type`);
  if (type === undefined) return undefined;
  if (type === "object") return { type, properties, required, closed: additional === NEVER };
  if (type === "array") return { type, items, prefix };
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

function present<T>(raw: unknown, at: string, references: References, parse: Parse<T>): T | undefined {
  return raw === undefined ? undefined : parse(raw, at, references);
}

function parseSchemaList(raw: unknown, at: string, references: References): SchemaNode[] {
  return parseList(raw, at).map((entry, index) => parseSchema(entry, `${at}/${index}`, references));
}

function parseSchemaMap(raw: unknown, at: string, references: References): Record<string, SchemaNode> {
  if (!isPlainObject(raw)) throw new Error(`${at}: expected a map of schemas`);
  return Object.fromEntries(Object.entries(raw).map(([key, entry]) => [key, parseSchema(entry, `${at}/${key}`, references)]));
}

function parseNames(raw: unknown, at: string): string[] {
  const names = parseList(raw, at);
  if (!names.every((name) => typeof name === "string")) throw new Error(`${at}: expected property names`);
  return names;
}

/** The root, or one entry of the root's `$defs` or `definitions`: what zod writes. Anything else could only be guessed at. */
const LOCAL_REFERENCE = /^#(?:\/(\$defs|definitions)\/([^/]+))?$/;

/** A target is read once, under a placeholder first, so a reference inside its own target ends the read instead of recursing. */
function parseReference(raw: unknown, at: string, references: References): SchemaNode {
  if (typeof raw !== "string") throw new Error(`${at}: expected a reference`);
  const match = LOCAL_REFERENCE.exec(raw);
  if (!match) throw new Error(`${at}: only a local reference to the root, $defs or definitions resolves, not ${raw}`);
  if (!references.nodes.has(raw)) {
    references.nodes.set(raw, NEVER);
    references.nodes.set(raw, parseSchema(resolveDefinition(references.root, match, at), raw, references));
  }
  return { kind: "ref", target: raw, references };
}

function resolveDefinition(root: unknown, [reference, container, token]: RegExpExecArray, at: string): unknown {
  const definitions = container !== undefined && isPlainObject(root) ? root[container] : undefined;
  const name = token === undefined ? undefined : decodeURIComponent(token).replaceAll("~1", "/").replaceAll("~0", "~");
  if (!isPlainObject(definitions) || name === undefined || !Object.hasOwn(definitions, name)) {
    throw new Error(`${at}: unresolvable reference ${reference}`);
  }
  return definitions[name];
}

/** A cycle of references that never steps into a property or element would recheck one value forever. */
function refuseReferenceCycles(nodes: ReadonlyMap<string, SchemaNode>): void {
  const settled = new Set<string>();
  const visit = (target: string, chain: readonly string[]): void => {
    if (chain.includes(target)) throw new Error(`${target}: reference cycle ${[...chain, target].join(" -> ")}`);
    if (settled.has(target)) return;
    const node = nodes.get(target);
    for (const next of node ? referencesAtSameValue(node) : []) visit(next, [...chain, target]);
    settled.add(target);
  };
  for (const target of nodes.keys()) visit(target, []);
}

function referencesAtSameValue(node: SchemaNode): string[] {
  switch (node.kind) {
    case "ref":
      return [node.target];
    case "all":
      return node.parts.flatMap(referencesAtSameValue);
    case "union":
      return node.branches.flatMap(referencesAtSameValue);
    case "not":
      return referencesAtSameValue(node.negated);
    default:
      return [];
  }
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
      return;
    case "all":
      for (const part of node.parts) collect(part, value, path, issues);
      return;
    case "not":
      if (fits(node.negated, value, path)) issues.push(`${path}: matched a shape it must not`);
      return;
    case "ref":
      collect(expandReference(node), value, path, issues);
  }
}

function expandReference({ target, references }: Extract<SchemaNode, { kind: "ref" }>): SchemaNode {
  references.expansionsLeft -= 1;
  if (references.expansionsLeft < 0) throw new Error(`${target}: references expand past ${REFERENCE_EXPANSIONS} checks`);
  const node = references.nodes.get(target);
  if (!node) throw new Error(`${target}: unresolvable reference ${target}`);
  return node;
}

function fits(node: SchemaNode, value: unknown, path: string): boolean {
  const scratch: string[] = [];
  collect(node, value, path, scratch);
  return scratch.length === 0;
}

function checkUnion(branches: readonly SchemaNode[], value: unknown, path: string, issues: string[]): void {
  const matched = branches.some((branch) => fits(branch, value, path));
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
  const { items, prefix } = shape;
  value.slice(0, prefix.length).forEach((entry, index) => collect(prefix[index] ?? OPEN, entry, `${path}[${index}]`, issues));
  if (!items) return;
  value.slice(prefix.length).forEach((entry, index) => collect(items, entry, `${path}[${index + prefix.length}]`, issues));
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
