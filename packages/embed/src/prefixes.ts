import { createHash } from "node:crypto";
import type { EmbedRole } from "./types.js";

/** The text an embedder prepends for each role. Models trained with task prefixes expect exactly one per text. */
export type RolePrefixes = Readonly<Record<EmbedRole, string>>;

export const NO_PREFIXES: RolePrefixes = { document: "", query: "" };

/** nomic-embed-text's retrieval task prefixes. */
export const NOMIC_PREFIXES: RolePrefixes = { document: "search_document: ", query: "search_query: " };

/** The prefixes a model is trained with; none unless it is a nomic model. */
export function defaultPrefixesFor(modelName: string): RolePrefixes {
  return modelName.includes("nomic") ? NOMIC_PREFIXES : NO_PREFIXES;
}

export function resolvePrefixes(modelName: string, overrides: Partial<RolePrefixes> = {}): RolePrefixes {
  const defaults = defaultPrefixesFor(modelName);
  return { document: overrides.document ?? defaults.document, query: overrides.query ?? defaults.query };
}

export function applyPrefix(texts: readonly string[], prefixes: RolePrefixes, role: EmbedRole = "document"): string[] {
  const prefix = prefixes[role];
  return prefix ? texts.map((t) => `${prefix}${t}`) : [...texts];
}

/**
 * The vector-space identity of a model under a prefix table, e.g.
 * `nomic-embed-text#p=1a2b3c4d`. Always suffixed, even for an empty table,
 * because a bare model name was the pre-0.2 key and could hold vectors made
 * under any prefix.
 */
export function vectorSpaceId(modelName: string, prefixes: RolePrefixes): string {
  const table = JSON.stringify([prefixes.document, prefixes.query]);
  const digest = createHash("sha256").update(table, "utf8").digest("hex").slice(0, 8);
  return `${modelName}#p=${digest}`;
}
