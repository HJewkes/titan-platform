import { citationHolds, citationsIn, type LineSource } from "@titan-design/evidence";
import type { ReviewOutcome } from "@titan-design/review-workflow";
import { citesPath } from "../corpus/cited-paths.js";
import type { ReplayExpected } from "./scenario.js";

/** The paths a FIX_FIRST's findings cite at lines that exist at the head; any other outcome cites none. */
function verifiedCitedPaths(outcome: ReviewOutcome, source: LineSource): string[] {
  if (outcome.kind !== "FIX_FIRST") return [];
  const paths = outcome.verdict.findings.flatMap((finding) =>
    citationsIn(finding.text).filter((range) => citationHolds(source, range)).map((range) => range.path),
  );
  return [...new Set(paths)].sort();
}

export interface ReplayScore {
  outcome: ReviewOutcome["kind"];
  /** A FIX_FIRST with a verified citation of the case's path. */
  hit: boolean;
  /** A hit on a case expected to pass. */
  falseCatch: boolean;
  /** The case's expected outcome, fingerprint and session count all held. */
  matched: boolean;
  sessions: number;
}

const fingerprintOf = (outcome: ReviewOutcome): string | undefined => (outcome.kind === "needs-fixer" ? outcome.fingerprint : undefined);

/** A block case is caught only by a verified citation naming its path; a FIX_FIRST that cites nothing checkable is no catch. */
export function scoreReplay(expected: ReplayExpected, outcome: ReviewOutcome, source: LineSource, sessions: number): ReplayScore {
  const path = expected.path;
  const hit = path !== undefined && verifiedCitedPaths(outcome, source).some((cited) => citesPath(cited, path));
  const verdictHeld = expected.verdict === undefined || (expected.verdict === "block") === hit;
  const matched =
    verdictHeld &&
    outcome.kind === expected.outcome &&
    (expected.fingerprint === undefined || fingerprintOf(outcome) === expected.fingerprint) &&
    (expected.sessions === undefined || sessions === expected.sessions);
  return { outcome: outcome.kind, hit, falseCatch: expected.verdict === "pass" && hit, matched, sessions };
}
