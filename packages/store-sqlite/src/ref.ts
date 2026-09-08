/**
 * The cross-domain identity grammar: `<kind>:<id>`, where `kind` is a short
 * lowercase token and `id` is anything the domain needs (paths, `repo#node`,
 * numbers). Every domain mints refs for its own entities and the shared edge
 * table links them, so `session:abc` can point at `codewatch:repo#src/a.ts::Foo`
 * without either side knowing the other's schema.
 */
export interface ParsedRef {
  kind: string;
  id: string;
}

const KIND = /^[a-z][a-z0-9_-]*$/;

export function ref(kind: string, id: string): string {
  if (!KIND.test(kind)) throw new Error(`invalid ref kind: ${JSON.stringify(kind)}`);
  if (id.length === 0) throw new Error("ref id must not be empty");
  return `${kind}:${id}`;
}

export function parseRef(value: string): ParsedRef {
  const at = value.indexOf(":");
  if (at <= 0 || at === value.length - 1 || !KIND.test(value.slice(0, at))) {
    throw new Error(`invalid ref: ${JSON.stringify(value)}`);
  }
  return { kind: value.slice(0, at), id: value.slice(at + 1) };
}

export function isRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    parseRef(value);
    return true;
  } catch {
    return false;
  }
}

/** A typed minter for one kind: `const session = refKind("session"); session("abc")`. */
export function refKind(kind: string): (id: string) => string {
  ref(kind, "probe");
  return (id) => ref(kind, id);
}
