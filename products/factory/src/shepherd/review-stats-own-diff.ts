import type { WorkflowRun } from "@titan-design/workflow";
import { OWN_DIFF_STEP } from "./own-diff.js";
import { payloadOf, stepName } from "./stats.js";

/** The part of a review round the own-diff labels read and write. */
interface OwnDiffRound {
  head: string | null;
  verdict: string | null;
  ownDiffId: string | null;
  unchangedSinceVerdict: string | null;
}

/** Only these resolve a round as a pass: a reviewer read the head and said so. */
const PASS_VERDICTS = new Set(["MERGE", "FIX_FIRST"]);

/** Each head's own-diff id: the recorded one, else the one read from the git-cache; an `unread` record, or none, leaves the head out. */
function ownDiffIds(run: WorkflowRun, backfilled: ReadonlyMap<string, string>): Map<string, string> {
  const ids = new Map<string, string>(backfilled);
  for (const [key, step] of Object.entries(run.stepResults)) {
    const result = payloadOf(step);
    const head = key.split(":")[1];
    if (stepName(key) === OWN_DIFF_STEP && head !== undefined && typeof result.id === "string") ids.set(head, result.id);
  }
  return ids;
}

/** A head's verdict as the next head's fix round reads it: any FIX_FIRST sends it back, else a MERGE stands, else it has none. */
function headVerdict(rounds: readonly OwnDiffRound[], head: string): string | null {
  const verdicts = rounds.filter((round) => round.head === head).map((round) => round.verdict);
  return verdicts.find((verdict) => verdict === "FIX_FIRST") ?? verdicts.find((verdict) => verdict === "MERGE") ?? null;
}

interface VerdictHead {
  id: string | undefined;
  verdict: string;
}

const labelOf = (id: string | undefined, previous: VerdictHead | undefined): string | null => {
  if (previous === undefined || id === undefined || previous.id === undefined) return null;
  return id === previous.id ? `after-${previous.verdict}` : "changed";
};

/**
 * Labels every pass of a run against the run's previous verdict head, in the order its heads were first reviewed: a pass at
 * a head whose own-diff id equals that head's re-read a change a reviewer had already judged. Every figure comes from the
 * run's own records, so a refresh labels a run the same way each time.
 */
export function labelOwnDiff(run: WorkflowRun, rounds: OwnDiffRound[], backfilled: ReadonlyMap<string, string> = new Map()): void {
  const ids = ownDiffIds(run, backfilled);
  const labels = new Map<string, string | null>();
  let previous: VerdictHead | undefined;
  for (const head of new Set(rounds.flatMap((round) => round.head ?? []))) {
    labels.set(head, labelOf(ids.get(head), previous));
    const verdict = headVerdict(rounds, head);
    if (verdict !== null) previous = { id: ids.get(head), verdict };
  }
  for (const round of rounds) {
    round.ownDiffId = round.head === null ? null : (ids.get(round.head) ?? null);
    round.unchangedSinceVerdict = round.head !== null && PASS_VERDICTS.has(round.verdict ?? "") ? (labels.get(round.head) ?? null) : null;
  }
}
