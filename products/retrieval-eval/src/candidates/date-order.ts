import { statSync } from "node:fs";
import path from "node:path";
import type { ScoredHit } from "../metrics.js";
import type { Arm } from "../pairs.js";
import { initiativeDir, LAYOUT, markdownIn } from "../workspace-layout.js";
import type { Candidate, SearchContext } from "./candidate.js";

/**
 * The historical floor the harness measures ranking against: notes chosen by
 * date, not by relevance.
 *
 * This is no longer production. Before CC-101 `agent_spawn` injected the newest
 * notes of the initiative into every brief, and the pre-TP-26 bootstrap did the
 * same with a longer list; both now rank. Today's baseline is the `served` arm
 * or the `active-work-search` row. The query is ignored on purpose — that is the
 * point being measured. Without this row, "recall@10 is 0.4" has nothing to be
 * better than.
 */

/**
 * How many notes each trigger injected before CC-101 and TP-26.
 *
 * Both were production constants, not tuning: 5 was agent-chat's `MAX_NOTES` in
 * `src/agents/active-work.ts`, and 12 was what the bootstrap listed before
 * TP-26 replaced date order with ranking.
 */
export const INJECTED_TODAY: Record<Arm, number> = { spawn: 5, bootstrap: 12 };

/**
 * Note filenames lead with `YYYY-MM-DD`, so reverse lexical order of the
 * filename is newest-first. Both dirs are merged before sorting, so a legacy
 * note never outranks a newer one just for the dir it sits in.
 */
export function newestNotes(dir: string, limit: number): string[] {
  const files = [LAYOUT.legacyNotes, LAYOUT.notes].flatMap((parts) => {
    const notes = path.join(dir, ...parts);
    return markdownIn(notes).map((name) => path.join(notes, name));
  });
  return files.sort(byFilenameDescending).slice(0, limit);
}

function byFilenameDescending(a: string, b: string): number {
  const [left, right] = [path.basename(a), path.basename(b)];
  return left < right ? 1 : left > right ? -1 : 0;
}

export interface DateOrderOptions {
  activeRoot: string;
  /** Overrides the historical counts; only a test should need this. */
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
