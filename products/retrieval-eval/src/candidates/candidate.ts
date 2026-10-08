import path from "node:path";
import type { ScoredHit } from "../metrics.js";
import type { Arm } from "../pairs.js";
import { refToPath } from "../workspace-layout.js";

/**
 * What a candidate knows about the pair beyond its query text.
 *
 * The date-order baseline needs it: what agent-chat injected before CC-101 was a function
 * of the initiative, not of the query, and a baseline that could not see the
 * initiative could not reproduce it.
 */
export interface SearchContext {
  arm: Arm;
  initiative?: string;
}

/**
 * One thing that can answer a query, so four very different retrievers are
 * comparable: a subprocess, a SQL query, an in-memory index, and a directory
 * listing sorted by date.
 *
 * `chars` on every hit is the excerpt the candidate would inject, not the file
 * behind it. That is the number a prompt budget actually pays, and it is the
 * one quantity all four can report on the same terms.
 */
export interface Candidate {
  readonly name: string;
  search(query: string, limit: number, context: SearchContext): Promise<ScoredHit[]>;
  close(): void;
}

/**
 * The paths a `note:<slug>/<file>` ref also goes by.
 *
 * A candidate that answers in refs and a label mined from a `Read` call name
 * the same note in different vocabularies; without this the ref-only
 * candidates would score zero against path labels.
 */
export function noteAliases(ref: string, activeRoot: string): string[] {
  const relative = ref.startsWith("note:") ? refToPath(ref, activeRoot) : undefined;
  return relative === undefined ? [] : [relative, path.join(activeRoot, relative)];
}
