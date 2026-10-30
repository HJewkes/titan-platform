import { parseResultLine, provedByMutants, type FixProofResult } from "./result-line.js";

/** Why a read proves nothing about its head; a head can force each of these, so none may pass on its own. */
export type FixProofUnverified = "error" | "refused" | "untrusted" | "unread" | "no-repro-test-only" | "no-repro-non-source";

/**
 * A fix-proof read as its readers hold it: a judged `line` (trusted, or `untrusted`), CI's own proof of a workflow-only diff,
 * a read that failed, or one that never ran. `nonSourceProceed` and `testOnlyProceed` mark a NO_REPRO the caller lets through.
 */
export type ProofReadInput = (
  | { kind: "result"; line: string; testOnlyProceed?: true }
  | { kind: "untrusted"; line: string; reason: string }
  | { kind: "workflow-ci"; proved: boolean; head: string }
  | { kind: "error"; reason: string }
  | { kind: "skipped" | "missing"; reason?: string }
) & { nonSourceProceed?: true };

type WorkflowCiProofRead = Extract<ProofReadInput, { kind: "workflow-ci" }>;

/** The one reading of a fix-proof read at a head. `unproven` is its own standing: it neither ends the review nor proves the head. */
export type ProofStanding =
  | { kind: "proved" }
  | { kind: "no-repro"; proceeds?: "test-only" | "non-source"; result: FixProofResult | WorkflowCiProofRead }
  | { kind: "unverified"; why: FixProofUnverified; detail?: string }
  | { kind: "unproven" }
  | { kind: "none" };

const NO_REPRO_VERDICTS: ReadonlySet<string> = new Set(["vacuous", "no-tests"]);
/** A line's verdict word that leaves its trusted read unverified: it ran nothing, or it could not finish. */
const UNVERIFIED_VERDICTS: ReadonlyMap<string, FixProofUnverified> = new Map([
  ["error", "error"],
  ["refused", "refused"],
]);

const unverified = (why: FixProofUnverified, detail: string | undefined): ProofStanding => ({ kind: "unverified", why, ...(detail !== undefined && { detail }) });

function proceedsOf(read: ProofReadInput): "test-only" | "non-source" | undefined {
  if (read.nonSourceProceed === true) return "non-source";
  return read.kind === "result" && read.testOnlyProceed === true ? "test-only" : undefined;
}

/** A vacuous or test-less line its mutants do not prove is NO_REPRO; a vacuous line they prove stands (tp#2145). */
function lineStanding(read: Extract<ProofReadInput, { kind: "result" }>, head: string): ProofStanding {
  const parsed = parseResultLine(read.line);
  if (!parsed.ok || parsed.result.head !== head) return unverified("unread", parsed.ok ? undefined : parsed.error);
  const { result } = parsed;
  if (NO_REPRO_VERDICTS.has(result.verdict) && !provedByMutants(result)) {
    const proceeds = proceedsOf(read);
    return { kind: "no-repro", ...(proceeds !== undefined && { proceeds }), result };
  }
  const why = UNVERIFIED_VERDICTS.get(result.verdict);
  if (why !== undefined) return unverified(why, result.error);
  return result.verdict === "unproven" ? { kind: "unproven" } : { kind: "proved" };
}

/** A workflow-only diff's CI read is NO_REPRO at its head unless CI proved it; a read of another head was never read for this one. */
function workflowCiStanding(read: WorkflowCiProofRead, head: string): ProofStanding {
  if (read.head !== head) return unverified("unread", undefined);
  if (read.proved) return { kind: "proved" };
  const proceeds = proceedsOf(read);
  return { kind: "no-repro", ...(proceeds !== undefined && { proceeds }), result: read };
}

/**
 * Where a fix-proof read leaves `head`. Every reader derives its answer from this, so a line cannot read as proved to one gate
 * and as NO_REPRO to another. A skipped or missing read expected no proof, so it is `none`.
 */
export function proofStanding(read: ProofReadInput, head: string): ProofStanding {
  switch (read.kind) {
    case "result":
      return lineStanding(read, head);
    case "workflow-ci":
      return workflowCiStanding(read, head);
    case "untrusted":
      return unverified("untrusted", read.reason);
    case "error":
      return unverified("unread", read.reason);
    default:
      return { kind: "none" };
  }
}

/** A NO_REPRO nothing lets through: the review ends before any reviewer starts unless the owner waived the proof. */
export const endsReview = (standing: ProofStanding): boolean => standing.kind === "no-repro" && standing.proceeds === undefined;

/** Anything short of a proof at the head makes the tests seat blocking; `unproven` does, though it does not end the review. */
export const needsTestsSeat = (standing: ProofStanding): boolean => standing.kind !== "proved" && standing.kind !== "none";
