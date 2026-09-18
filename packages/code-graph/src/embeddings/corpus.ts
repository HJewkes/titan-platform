import { contentHashOf } from "@titan-design/store-sqlite";
import type { CodeGraphStore } from "../store.js";
import type { GraphNode } from "../types.js";
import type { EmbeddableSymbol } from "./types.js";

/** Mirrors the gate harness: purpose text is appended to the signature when present. */
export function buildEmbedText(signature: string, purpose?: string | null): string {
  return purpose ? `${signature} -- ${purpose}` : signature;
}

export function hashEmbedText(text: string): string {
  return contentHashOf(text);
}

const TEST_OR_FIXTURE_PATH = /\.test\.|\.spec\.|__tests__|\/fixtures\//;
const EXCLUDED_FILE_ROLES = new Set(["test", "generated"]);

interface SymbolTextAttrs {
  exported?: boolean;
  signature?: string;
  purpose?: string;
}

/**
 * The embeddable corpus of a snapshot: exported symbols that carry a signature,
 * excluding test/fixture/generated code (matching the validated gate corpus).
 */
export function listEmbeddableSymbols(store: CodeGraphStore, snapshotId: number): EmbeddableSymbol[] {
  const nodes = store.listNodes(snapshotId, { includeSymbols: true });
  const fileRoles = new Map<string, string | null>();
  for (const n of nodes) if (n.kind === "file") fileRoles.set(n.id, n.role ?? null);
  const out: EmbeddableSymbol[] = [];
  for (const n of nodes) {
    const symbol = toEmbeddable(n, fileRoles);
    if (symbol) out.push(symbol);
  }
  return out;
}

function toEmbeddable(node: GraphNode, fileRoles: ReadonlyMap<string, string | null>): EmbeddableSymbol | null {
  if (node.kind !== "symbol") return null;
  const attrs = (node.attrs ?? {}) as SymbolTextAttrs;
  if (attrs.exported !== true || !attrs.signature) return null;
  const file = node.parentId ?? node.id.split("#")[0] ?? node.id;
  if (TEST_OR_FIXTURE_PATH.test(file)) return null;
  const role = fileRoles.get(file);
  if (role && EXCLUDED_FILE_ROLES.has(role)) return null;
  const text = buildEmbedText(attrs.signature, attrs.purpose);
  return {
    id: node.id,
    name: node.name,
    file,
    signature: attrs.signature,
    purpose: attrs.purpose,
    text,
    textHash: hashEmbedText(text),
  };
}
