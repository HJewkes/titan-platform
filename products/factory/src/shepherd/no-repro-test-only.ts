import { parseResultLine } from "@titan-design/fix-proof";
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { codeFreeDiff, supportOnlyDiff, testOnlyDiff, type TestOnlyDiff } from "./test-only-diff.js";

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

/** Whether the NO_REPRO proceeds; `unreadReason` is why the diff stayed unread after its retry, so a run record can name it. */
interface NoReproDecision {
  proceeds: boolean;
  unreadReason?: string;
}

/**
 * Decision 424(1): with the flag on, a test-only or correctness registration whose diff the fail-closed classifier reads in full as
 * tests alone does not end its review on a vacuous proof. A result that carries mutants stays NO_REPRO, since a surviving mutation
 * or a refused spec is a verdict on the tests. TP-4573: a test-only registration also proceeds on a diff of test support with no test
 * in it, which no proof can run; a correctness one stays gated there, since nothing shows its fix is in the tests.
 */
export async function proceedsOnNoRepro(port: GitHubPort, gate: NoReproTestOnly, line: string): Promise<NoReproDecision> {
  if (gate.flag !== "on" || !TEST_ONLY_PROOF_KINDS.has(gate.kind)) return { proceeds: false };
  if (!mayProceedLine(line)) return { proceeds: false };
  const diff = await readDiffTwice(port, gate);
  if (diff.kind === "test-only") return { proceeds: true };
  if (diff.kind === "unread") return { proceeds: false, unreadReason: diff.reason };
  return { proceeds: gate.kind === "test-only" && (await supportOnlyDiff(port, gate.repo, gate.pr, gate.head)) };
}

/** The diff read fails closed on any GitHub error, so one transient error would end a test-only review; a second read tells it from a real refusal. */
async function readDiffTwice(port: GitHubPort, gate: NoReproTestOnly): Promise<TestOnlyDiff> {
  const first = await testOnlyDiff(port, gate.repo, gate.pr, gate.head);
  return first.kind === "unread" ? testOnlyDiff(port, gate.repo, gate.pr, gate.head) : first;
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

/**
 * TP-5399: a no-tests line with no mutants and no deleted test, on a diff with no source and no test file (`codeFreeDiff`), has
 * nothing a proof could reproduce, so it goes on to review under any kind and any flag; waking the implementer could only dead-end.
 */
export async function codeFreeNoRepro(port: GitHubPort, at: { repo: RepoSlug; pr: number | null; head: string }, line: string): Promise<boolean> {
  const parsed = parseResultLine(line);
  if (!mayProceedLine(line) || !parsed.ok || parsed.result.verdict !== "no-tests" || parsed.result.deletedTests.length > 0) return false;
  return codeFreeDiff(port, at.repo, at.pr, at.head);
}
