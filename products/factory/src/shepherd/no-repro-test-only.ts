import { parseResultLine } from "@titan-design/fix-proof";
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { testOnlyDiff } from "./test-only-diff.js";

/** A vacuous or test-less proof: the two results the NO_REPRO verdict ends a review on. */
const VACUOUS_VERDICTS: ReadonlySet<string> = new Set(["vacuous", "no-tests"]);

/**
 * TP-3261: a correctness PR whose diff is tests alone runs the same source on both sides, so it can never reproduce; the diff,
 * not the label, makes it test-only for proof. Security keeps its gate, as it keeps its fresh reviewer (`kindMoveRefusal`).
 */
const TEST_ONLY_PROOF_KINDS: ReadonlySet<string> = new Set(["test-only", "correctness"]);

interface NoReproTestOnly {
  /** `shepherd.gateReset.noReproProceed`; absent means `off`. */
  flag: "off" | "on" | undefined;
  /** The run's registered kind. */
  kind: string;
  repo: RepoSlug;
  pr: number | null;
  /** The head the proof was read at. */
  head: string;
}

/**
 * Decision 424(1): with the flag on, a test-only or correctness registration whose diff the fail-closed classifier reads in full as
 * tests alone does not end its review on a vacuous proof. A result that carries mutants stays NO_REPRO, since a surviving mutation
 * or a refused spec is a verdict on the tests.
 */
export async function proceedsOnNoRepro(port: GitHubPort, gate: NoReproTestOnly, line: string): Promise<boolean> {
  if (gate.flag !== "on" || !TEST_ONLY_PROOF_KINDS.has(gate.kind)) return false;
  if (!mayProceedLine(line)) return false;
  return (await testOnlyDiff(port, gate.repo, gate.pr, gate.head)).kind === "test-only";
}

/**
 * A vacuous or test-less line with no mutants: the only NO_REPRO line any proceed path may let past. A line carrying mutants stays
 * NO_REPRO, since a surviving mutation or a refused spec is a verdict on the tests.
 */
export function mayProceedLine(line: string): boolean {
  const parsed = parseResultLine(line);
  if (!parsed.ok || !VACUOUS_VERDICTS.has(parsed.result.verdict) || parsed.result.mutants !== undefined) return false;
  return true;
}
