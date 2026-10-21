import type { ArLadder, ArOutcome, ArRunView } from "../../server/autoresearch-view.js";
import { ladders } from "./autoresearch-format.js";
import { ladderUsd } from "./autoresearch-progress.js";

type Decided = ArLadder & { outcome: ArOutcome };

export const STOP_RUNGS = ["L0", "L1", "L2", "L3"] as const;

/** One idea on a wins or losses list, ranked by how far it landed from B in σ. */
export interface Ranked {
  id: string;
  cell: string;
  deltaOverSigma: number;
}

export interface Scoreboard {
  kept: number;
  rejected: number;
  stopped: number;
  superseded: number;
  /** Kept over kept, rejected and stopped; a superseded winner is back in the queue, so it is not a decision yet. */
  keepRate: number | undefined;
  stopsByRung: Record<(typeof STOP_RUNGS)[number], number>;
  usdPerKept: number | undefined;
  /** Spend on ideas rejected at L2 or L3: the evals ran in full and bought no keep. */
  wastedUsd: number;
  wins: Ranked[];
  losses: Ranked[];
}

const isSuperseded = (ladder: Decided): boolean => ladder.outcome.reason === "superseded";

const pastL1 = (ladder: Decided): boolean => ladder.outcome.rungReached === "L2" || ladder.outcome.rungReached === "L3";

/** Δ/σ needs both; an outcome missing either has no place on a ranked list. */
function ranked(rows: readonly Decided[]): Ranked[] {
  return rows
    .flatMap(({ idea, outcome }) =>
      outcome.delta === undefined || outcome.sigma === undefined || outcome.sigma === 0 ? [] : [{ id: idea.id, cell: idea.cell, deltaOverSigma: outcome.delta / outcome.sigma }],
    )
    .sort((a, b) => Math.abs(b.deltaOverSigma) - Math.abs(a.deltaOverSigma));
}

function stopsByRung(rows: readonly Decided[]): Scoreboard["stopsByRung"] {
  const counts = { L0: 0, L1: 0, L2: 0, L3: 0 };
  for (const { outcome } of rows) if (outcome.rungReached !== "none") counts[outcome.rungReached] += 1;
  return counts;
}

/** Design §1.5's scoreboard, wins and losses, over every idea that has an outcome. */
export function scoreboard(run: ArRunView): Scoreboard {
  const decided = ladders(run).filter((ladder): ladder is Decided => ladder.outcome !== null);
  const by = (verdict: ArOutcome["verdict"]) => decided.filter((ladder) => ladder.outcome.verdict === verdict && !isSuperseded(ladder));
  const [kept, rejected, stopped] = [by("kept"), by("rejected"), by("stopped")];
  const judged = kept.length + rejected.length + stopped.length;
  const spend = decided.reduce((sum, ladder) => sum + ladderUsd(ladder), 0);
  return {
    kept: kept.length,
    rejected: rejected.length,
    stopped: stopped.length,
    superseded: decided.filter(isSuperseded).length,
    keepRate: judged === 0 ? undefined : kept.length / judged,
    stopsByRung: stopsByRung([...rejected, ...stopped]),
    usdPerKept: kept.length === 0 ? undefined : spend / kept.length,
    wastedUsd: rejected.filter(pastL1).reduce((sum, ladder) => sum + ladderUsd(ladder), 0),
    wins: ranked(kept),
    losses: ranked(rejected.filter(pastL1)),
  };
}
