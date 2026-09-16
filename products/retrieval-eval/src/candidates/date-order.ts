import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { ScoredHit } from "../metrics.js";
import type { Arm } from "../pairs.js";
import type { Candidate, SearchContext } from "./candidate.js";

/**
 * The baseline the whole harness exists to beat: notes chosen by date, not by
 * relevance.
 *
 * This is not a strawman, it is production. `agent_spawn` injects the newest
 * notes of the initiative into every brief, and the pre-TP-26 bootstrap did the
 * same with a longer list. The query is ignored on purpose — that is the point
 * being measured. Without this row, "recall@10 is 0.4" has nothing to be better
 * than.
 */

/**
 * How many notes each trigger injects today.
 *
 * Both are production constants, not tuning: 5 is agent-chat's `MAX_NOTES` in
 * `src/agents/active-work.ts`, and 12 is what the bootstrap listed before
 * TP-26 replaced date order with ranking.
 */
export const INJECTED_TODAY: Record<Arm, number> = { spawn: 5, bootstrap: 12 };

/** Note filenames lead with `YYYY-MM-DD`, so reverse lexical order is newest-first. */
export function newestNotes(initiativeDir: string, limit: number): string[] {
  const dirs = [path.join(initiativeDir, "notes"), path.join(initiativeDir, "sources", "notes")];
  const files = dirs.flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith(".md"))
          .sort()
          .reverse()
          .slice(0, limit)
          .map((name) => path.join(dir, name))
      : [],
  );
  return files.slice(0, limit);
}

export interface DateOrderOptions {
  activeRoot: string;
  /** Overrides the production counts; only a test should need this. */
  counts?: Record<Arm, number>;
}

/**
 * An initiative that cannot be resolved yields no hits, which scores as a miss.
 *
 * That is the honest reading rather than an exclusion: a spawn whose briefing
 * slug is unresolvable is one where today's mechanism injected no notes at all.
 */
export function dateOrderNotes(options: DateOrderOptions): Candidate {
  const counts = options.counts ?? INJECTED_TODAY;
  return {
    name: "date-order-notes",
    async search(_query: string, limit: number, context: SearchContext): Promise<ScoredHit[]> {
      if (context.initiative === undefined) return [];
      const dir = initiativeDir(options.activeRoot, context.initiative);
      if (dir === undefined) return [];
      const files = newestNotes(dir, counts[context.arm]);
      return files.slice(0, limit).map((file) => ({ id: file, chars: sizeOf(file) }));
    },
    close() {},
  };
}

/** Live initiatives first, then the archive, since a retired one is still real data. */
function initiativeDir(activeRoot: string, slug: string): string | undefined {
  for (const dir of [path.join(activeRoot, slug), path.join(activeRoot, "archive", slug)]) {
    if (existsSync(dir)) return dir;
  }
  return undefined;
}

/**
 * File size, not an excerpt: this candidate injects whole paths for the agent
 * to open, so the characters it costs are the file's. Stated in REPORT.md,
 * because it makes its budget column incomparable with the excerpt candidates.
 */
function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
