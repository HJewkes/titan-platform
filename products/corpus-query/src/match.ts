import type { QuerySpec } from "./types.js";

export type MatchTerms = Partial<Pick<QuerySpec, "termGroups" | "phrases" | "seedLexicon">>;

/** One FTS5 string token; quotes are doubled so user punctuation can never reach the query grammar. */
function quoteToken(raw: string): string | undefined {
  const prefix = raw.endsWith("*");
  const body = (prefix ? raw.slice(0, -1) : raw).replaceAll('"', '""').trim();
  if (!/[\p{L}\p{N}]/u.test(body)) return undefined;
  return `"${body}"${prefix ? "*" : ""}`;
}

function orOf(terms: string[]): string | undefined {
  const quoted = terms.map(quoteToken).filter((t) => t !== undefined);
  if (quoted.length === 0) return undefined;
  return quoted.length === 1 ? quoted[0] : `(${quoted.join(" OR ")})`;
}

/**
 * The FTS5 expression for a spec: every term group must be present (AND of ORs), or any phrase, or any lexicon term.
 * A group whose terms are all unusable is dropped rather than turned into a match-all.
 */
export function buildMatch(terms: MatchTerms): string {
  const groups = (terms.termGroups ?? []).map(orOf).filter((g) => g !== undefined);
  const alternatives = [
    ...(groups.length > 0 ? [groups.length === 1 ? groups[0]! : `(${groups.join(" AND ")})`] : []),
    ...(terms.phrases ?? []).map((p) => orOf([p])),
    ...(terms.seedLexicon ?? []).map((t) => orOf([t])),
  ].filter((a) => a !== undefined);
  if (alternatives.length === 0) throw new Error("query has no searchable terms");
  return alternatives.join(" OR ");
}
