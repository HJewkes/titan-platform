import { parseResultLine } from "@titan-design/fix-proof";
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { testOnlyDiff } from "./test-only-diff.js";

/** A vacuous or test-less proof: the two results the NO_REPRO verdict ends a review on. */
const VACUOUS_VERDICTS: ReadonlySet<string> = new Set(["vacuous", "no-tests"]);

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
 * Decision 424(1): with the flag on, a test-only registration whose diff the fail-closed classifier reads in full as tests alone
 * does not end its review on a vacuous proof. A result that carries mutants stays NO_REPRO, since a surviving mutation is a verdict on the tests.
 */
export async function proceedsOnNoRepro(port: GitHubPort, gate: NoReproTestOnly, line: string): Promise<boolean> {
  if (gate.flag !== "on" || gate.kind !== "test-only") return false;
  const parsed = parseResultLine(line);
  if (!parsed.ok || !VACUOUS_VERDICTS.has(parsed.result.verdict) || parsed.result.mutants !== undefined) return false;
  return (await testOnlyDiff(port, gate.repo, gate.pr, gate.head)).kind === "test-only";
}
