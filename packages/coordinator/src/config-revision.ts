import { createHash } from "node:crypto";
import { z } from "zod";
import { isObjectLike, isRecord } from "@titan-design/rpc-protocol/narrow";
import { checkCoordinatorConfig, coordinatorConfigSchema } from "./coordinator-config.js";
import type { CoordinatorConfig, CoordinatorConfigError } from "./coordinator-config.js";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** One entry of a coordinator document's revision log; `parent` is the previous revision's `revisionSha`. */
export type ConfigRevision = {
  $schema: "titan-coordinator-revision/v1";
  rev: number;
  parent: string | null;
  at: string;
  by: { class: "owner-remote" | "owner-terminal" | "import"; id: string };
  /** sha256 of the action record that authorized the change; an import has none. */
  action?: string | undefined;
  notes?: string[] | undefined;
  document: CoordinatorConfig;
};

// Annotated so the published type names CoordinatorConfig instead of expanding it.
export const configRevisionSchema: z.ZodType<ConfigRevision> = z.strictObject({
  $schema: z.literal("titan-coordinator-revision/v1"),
  rev: z.number().int().nonnegative(),
  parent: sha256.nullable(),
  at: z.iso.datetime({ offset: true }),
  by: z.strictObject({ class: z.enum(["owner-remote", "owner-terminal", "import"]), id: z.string().min(1) }),
  action: sha256.optional(),
  notes: z.array(z.string()).optional(),
  document: coordinatorConfigSchema,
});

export type ConfigEditResult =
  | { ok: true; document: CoordinatorConfig }
  | { ok: false; errors: CoordinatorConfigError[] };
export type DocumentChange = {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
};
export type ChainError = { rev: number; code: "invalid" | "sequence" | "parent" | "document"; message: string };
export type ChainResult = { ok: true; head: ConfigRevision } | { ok: false; errors: ChainError[] };

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

// Sorted keys make the digest independent of the order a writer emitted them in.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, node: unknown) =>
    isRecord(node) ? Object.fromEntries(Object.keys(node).sort().map((key) => [key, node[key]])) : node,
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** sha256 of a document's canonical JSON: what a reader compares a materialized file against. */
export function documentSha(document: unknown): string {
  return digest(document);
}

/** sha256 of a revision's canonical JSON: the value its child names as `parent`. */
export function revisionSha(revision: unknown): string {
  return digest(revision);
}

type SchemaNode = z.core.$ZodType;

function unwrap(schema: SchemaNode): SchemaNode {
  let node = schema;
  while (node instanceof z.core.$ZodOptional || node instanceof z.core.$ZodNullable || node instanceof z.core.$ZodDefault) {
    node = node._zod.def.innerType;
  }
  return node;
}

/** The schema node at `key` under `schema`, or undefined when the schema declares no such key. */
function childSchema(schema: SchemaNode, key: string): SchemaNode | undefined {
  const node = unwrap(schema);
  if (node instanceof z.core.$ZodObject) {
    const { shape } = node._zod.def;
    return Object.hasOwn(shape, key) ? shape[key] : undefined;
  }
  if (node instanceof z.core.$ZodRecord) return node._zod.def.valueType;
  if (node instanceof z.core.$ZodArray && /^\d+$/.test(key)) return node._zod.def.element;
  return undefined;
}

function refuse(path: string, message: string): ConfigEditResult {
  return { ok: false, errors: [{ code: "invalid", path, message }] };
}

function schemaRefusal(keys: string[]): string | undefined {
  let schema: SchemaNode = coordinatorConfigSchema;
  for (const [i, key] of keys.entries()) {
    if (key === "" || UNSAFE_KEYS.has(key)) return `segment ${i} (${JSON.stringify(key)}) is not a field name`;
    const child = childSchema(schema, key);
    if (!child) return `${keys.slice(0, i + 1).join(".")} is not in the titan-coordinator/v1 schema`;
    schema = child;
  }
  return undefined;
}

/**
 * Sets one field of a copy of `doc`; never mutates it and never throws. Refuses a path the schema
 * does not declare, a path whose parent object is absent, and a result that fails `checkCoordinatorConfig`.
 */
export function applyEdit(doc: CoordinatorConfig, path: string, value: unknown): ConfigEditResult {
  const keys = path.split(".");
  const refusal = schemaRefusal(keys);
  if (refusal) return refuse(path, refusal);
  const copy: unknown = structuredClone(doc);
  let node = copy;
  for (const key of keys.slice(0, -1)) {
    node = isObjectLike(node) ? node[key] : undefined;
    if (node === undefined || node === null) return refuse(path, `${key} is absent; an edit never creates a parent`);
  }
  if (!isObjectLike(node)) return refuse(path, "the parent of the edited field is not an object");
  node[keys[keys.length - 1]!] = structuredClone(value);
  const checked = checkCoordinatorConfig(copy);
  return checked.ok ? { ok: true, document: checked.config } : checked;
}

function diffAt(path: string, before: unknown, after: unknown, out: DocumentChange[]): void {
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) diffAt(path === "" ? key : `${path}.${key}`, before[key], after[key], out);
    return;
  }
  if (before === undefined && after !== undefined) out.push({ path, kind: "added", after });
  else if (after === undefined && before !== undefined) out.push({ path, kind: "removed", before });
  else if (canonicalJson(before) !== canonicalJson(after)) out.push({ path, kind: "changed", before, after });
}

/** Leaf-level changes from `before` to `after`, sorted by key; an array is one leaf. */
export function diffDocuments(before: unknown, after: unknown): DocumentChange[] {
  const out: DocumentChange[] = [];
  diffAt("", before, after, out);
  return out;
}

function linkErrors(revision: ConfigRevision, index: number, previous: unknown): ChainError[] {
  const errors: ChainError[] = [];
  if (revision.rev !== index) {
    errors.push({ rev: revision.rev, code: "sequence", message: `revision at position ${index} is numbered ${revision.rev}` });
  }
  const expected = index === 0 ? null : revisionSha(previous);
  if (revision.parent !== expected) {
    const want = expected === null ? "no parent" : `revision ${index - 1} (${expected})`;
    errors.push({ rev: revision.rev, code: "parent", message: `parent ${revision.parent} is not ${want}` });
  }
  return errors;
}

function documentErrors(revision: ConfigRevision): ChainError[] {
  const checked = checkCoordinatorConfig(revision.document);
  if (checked.ok) return [];
  return checked.errors.map((error) => ({ rev: revision.rev, code: "document", message: `${error.path}: ${error.message}` }));
}

/**
 * Checks a revision log oldest first: each entry parses, is numbered by its position, names the
 * previous entry's `revisionSha` as its parent (rev 0 names none), and carries a valid document.
 */
export function verifyChain(revisions: readonly unknown[]): ChainResult {
  if (revisions.length === 0) return { ok: false, errors: [{ rev: 0, code: "sequence", message: "the log is empty" }] };
  const errors = revisions.flatMap((raw, index): ChainError[] => {
    const parsed = configRevisionSchema.safeParse(raw);
    if (!parsed.success) {
      return [{ rev: index, code: "invalid", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }];
    }
    return [...linkErrors(parsed.data, index, revisions[index - 1]), ...documentErrors(parsed.data)];
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, head: configRevisionSchema.parse(revisions[revisions.length - 1]) };
}
