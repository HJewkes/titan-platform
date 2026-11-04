import { wilson, type Interval } from "@titan-design/evidence/stats";
import { hashCanonical } from "../hash.js";
import type { EvalCase } from "../spec/index.js";
import type { ReplayResult, ReplayVariant } from "./replay.js";
import { replayExpectedSchema } from "./scenario.js";

/** The outcomes that carry a panel verdict; every other kind is a head the run left without one. */
const VERDICT_OUTCOMES: ReadonlySet<string> = new Set(["MERGE", "FIX_FIRST"]);

export interface ScorecardCase {
  caseId: string;
  seed: boolean;
  verdict?: "block" | "pass";
  hit: boolean;
  outcome: string;
  reached: boolean;
  sessions: number;
}

/**
 * One variant over one suite. A replay spends nothing and takes no wall time, so reviewer sessions stand for cost, and
 * no latency or spend is reported. No-verdict counts list only the outcome kinds the replay produced.
 */
export interface ReviewScorecard {
  variant: string;
  /** The hash of the variant's plan policy: equal plans mean only retry or timing rows changed. */
  plan: string;
  suite: string;
  heads: number;
  catchRate: Interval & { caught: number; blocking: number };
  falseBlocks: { count: number; passing: number };
  sessionsPerHead: number;
  verdictsReached: number;
  noVerdict: Record<string, number>;
  /** Keyed by case hash, so two scorecards pair on content rather than on id. */
  cases: Record<string, ScorecardCase>;
}

function caseRow(evalCase: EvalCase, result: ReplayResult): ScorecardCase {
  const { verdict } = replayExpectedSchema.parse(evalCase.expected);
  const reached = VERDICT_OUTCOMES.has(result.outcome);
  const row = { caseId: evalCase.id, seed: evalCase.tags.includes("seed"), hit: result.hit, outcome: result.outcome, reached, sessions: result.sessions };
  return verdict === undefined ? row : { ...row, verdict };
}

function rowsOf(variant: ReplayVariant, cases: readonly EvalCase[], results: readonly ReplayResult[]): Record<string, ScorecardCase> {
  const variantHash = hashCanonical(variant.policy);
  const rows: Record<string, ScorecardCase> = {};
  for (const result of results) {
    if (result.variantHash !== variantHash) throw new Error(`result for ${result.caseId} is from another variant than ${variant.id}`);
    const evalCase = cases.find((candidate) => candidate.id === result.caseId);
    if (evalCase === undefined) throw new Error(`result for ${result.caseId} has no case in the suite`);
    rows[result.caseHash] = caseRow(evalCase, result);
  }
  if (Object.keys(rows).length !== cases.length) throw new Error(`${variant.id} has ${Object.keys(rows).length} results for ${cases.length} cases`);
  return rows;
}

/** Scores one variant's replay results over the suite they came from. */
export function reviewScorecard(variant: ReplayVariant, cases: readonly EvalCase[], results: readonly ReplayResult[]): ReviewScorecard {
  const rows = rowsOf(variant, cases, results);
  const all = Object.values(rows);
  const blocking = all.filter((row) => row.verdict === "block");
  const passing = all.filter((row) => row.verdict === "pass");
  const caught = blocking.filter((row) => row.hit).length;
  const noVerdict: Record<string, number> = {};
  for (const row of all) if (!row.reached) noVerdict[row.outcome] = (noVerdict[row.outcome] ?? 0) + 1;
  return {
    variant: hashCanonical(variant.policy),
    plan: hashCanonical(variant.policy.plan),
    suite: hashCanonical(Object.keys(rows).sort()),
    heads: all.length,
    catchRate: { ...wilson(caught, blocking.length), caught, blocking: blocking.length },
    falseBlocks: { count: passing.filter((row) => row.hit).length, passing: passing.length },
    sessionsPerHead: all.reduce((sum, row) => sum + row.sessions, 0) / Math.max(all.length, 1),
    verdictsReached: all.filter((row) => row.reached).length,
    noVerdict,
    cases: rows,
  };
}

/** `reliability`: only retry or timing rows changed, so the failure fixtures decide. `verdict`: the plan changed. */
export type AcceptTrack = "reliability" | "verdict";

export interface Comparison {
  track: AcceptTrack;
  accept: boolean;
  /** Why the candidate was rejected; empty on accept. */
  reasons: string[];
  /** Candidate minus incumbent; positive means the candidate costs more or catches more. */
  sessionsPerHeadDelta: number;
  caughtDelta: number;
}

/** A seed case is a floor on every track: a blocking head must be caught and a passing one must not be. */
function seedMisses(candidate: ReviewScorecard): string[] {
  return Object.values(candidate.cases)
    .filter((row) => row.seed && row.verdict !== undefined && row.hit !== (row.verdict === "block"))
    .map((row) => `seed case ${row.caseId} ${row.verdict === "block" ? "missed" : "falsely blocked"}`);
}

/** A loop: a head left with no verdict on which the candidate spent more reviewer sessions than the incumbent. */
function newLoops(candidate: ReviewScorecard, incumbent: ReviewScorecard): string[] {
  return Object.entries(candidate.cases)
    .filter(([hash, row]) => !row.reached && row.sessions > (incumbent.cases[hash]?.sessions ?? Infinity))
    .map(([, row]) => `new loop on ${row.caseId}`);
}

function reliabilityReasons(candidate: ReviewScorecard, incumbent: ReviewScorecard): string[] {
  const reasons = newLoops(candidate, incumbent);
  if (candidate.verdictsReached < incumbent.verdictsReached) reasons.push("fewer verdicts reached");
  if (candidate.sessionsPerHead > incumbent.sessionsPerHead) reasons.push("more sessions per head");
  return reasons;
}

/** TP-1930's rule: catch not lower with lower cost, or catch higher whatever the cost delta. */
function verdictReasons(candidate: ReviewScorecard, incumbent: ReviewScorecard): string[] {
  const { caught } = candidate.catchRate;
  if (caught > incumbent.catchRate.caught) return [];
  if (caught < incumbent.catchRate.caught) return ["lower catch on paired cases"];
  return candidate.sessionsPerHead < incumbent.sessionsPerHead ? [] : ["same catch without lower cost"];
}

/**
 * The TP-3916 §2(d) accept rule. A verdict-track accept still runs 10 live heads in shadow before the flag; that step is
 * the caller's.
 */
export function compare(candidate: ReviewScorecard, incumbent: ReviewScorecard): Comparison {
  const track: AcceptTrack = candidate.plan === incumbent.plan ? "reliability" : "verdict";
  const deltas = {
    sessionsPerHeadDelta: candidate.sessionsPerHead - incumbent.sessionsPerHead,
    caughtDelta: candidate.catchRate.caught - incumbent.catchRate.caught,
  };
  if (candidate.suite !== incumbent.suite) return { track, accept: false, reasons: ["scored on a different suite"], ...deltas };
  const trackReasons = track === "reliability" ? reliabilityReasons(candidate, incumbent) : verdictReasons(candidate, incumbent);
  const reasons = [...seedMisses(candidate), ...trackReasons];
  return { track, accept: reasons.length === 0, reasons, ...deltas };
}
