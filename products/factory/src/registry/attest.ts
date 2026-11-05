import type { ReviewerAgent } from "@titan-design/review-panel";

/** One row of an `attestations/<pr>.json` file, the shape of the closure check's own: the PR claims `step`'s behaviour is unchanged at import closure `closure`. */
export interface Attestation {
  step: string;
  closure: string;
  pr: number;
}

/** A step and the first 12 hex of the closure a reviewer's `Attests:` line names. */
interface AttestToken {
  step: string;
  closure12: string;
}

/** A reviewer's MERGE at a head, with the tokens of its `Attests:` line; an undefined reviewer is one the roster cannot name. */
export interface AttestingVerdict {
  reviewer: ReviewerAgent | undefined;
  attests: readonly string[];
  head: string;
}

export interface JudgeInput {
  claimed: readonly Attestation[];
  /** The head the merge is decided at; a verdict at any other head meets nothing. */
  head: string;
  correctness: AttestingVerdict & { carried: boolean };
  adversary?: AttestingVerdict;
  adversaryRequired: boolean;
  /** True only for an agent that wrote none of the run's code, by the run's authors and the roster's lineage. */
  independent: (agent: ReviewerAgent) => boolean;
  /** True only when the roster proves the two reviewers are separate conversations. */
  separate: (a: ReviewerAgent, b: ReviewerAgent) => boolean;
}

type UnmetReason = "no-meeter" | "meeter-is-author" | "adversary-missing" | "adversary-same-lineage" | "closure-mismatch" | "carried";

interface Met {
  step: string;
  closure: string;
  meeters: ReviewerAgent[];
}

interface Unmet {
  step: string;
  closure: string;
  why: UnmetReason;
}

const TOKEN = /^(?<step>[a-z0-9-]+)@(?<closure12>[0-9a-f]{12})$/;

/** Well-formed tokens only, the first per step; a malformed token names nothing. */
function parseAttestTokens(tokens: readonly string[]): AttestToken[] {
  const parsed: AttestToken[] = [];
  for (const token of tokens) {
    const { step, closure12 } = TOKEN.exec(token.trim())?.groups ?? {};
    if (step !== undefined && closure12 !== undefined && !parsed.some((seen) => seen.step === step)) parsed.push({ step, closure12 });
  }
  return parsed;
}

/** The head rows with no identical row at base: a row carried over unchanged was attested before and is not claimed again. */
export function claimedRows(base: readonly Attestation[], head: readonly Attestation[]): Attestation[] {
  return head.filter((row) => !base.some((old) => old.step === row.step && old.closure === row.closure && old.pr === row.pr));
}

/** Why one verdict does not meet `row`, or undefined when it does. */
function verdictShortfall(row: Attestation, verdict: AttestingVerdict, input: JudgeInput): UnmetReason | undefined {
  if (verdict.head !== input.head) return "carried";
  const token = parseAttestTokens(verdict.attests).find((named) => named.step === row.step);
  if (token === undefined) return "no-meeter";
  if (!row.closure.startsWith(token.closure12)) return "closure-mismatch";
  if (verdict.reviewer === undefined || !input.independent(verdict.reviewer)) return "meeter-is-author";
  return undefined;
}

/** The adversary's own shortfall, read only where the class has one. */
function adversaryShortfall(row: Attestation, input: JudgeInput): UnmetReason | undefined {
  const { adversary, correctness } = input;
  if (adversary === undefined) return "adversary-missing";
  const shortfall = verdictShortfall(row, adversary, input);
  if (shortfall === "no-meeter") return "adversary-missing";
  if (shortfall !== undefined) return shortfall;
  if (!correctness.reviewer || !adversary.reviewer || !input.separate(correctness.reviewer, adversary.reviewer)) return "adversary-same-lineage";
  return undefined;
}

/**
 * Each claimed row is met by an independent reviewer's MERGE at this exact head whose `Attests:` line names the row's
 * step and closure, and, where the class has an adversary, by the adversary's line too from a separate conversation.
 * The implementer and every fixer fail `independent`, so they never meet a row. A carried verdict meets nothing in M1b.
 */
export function judgeAttestations(input: JudgeInput): { met: Met[]; unmet: Unmet[] } {
  const met: Met[] = [];
  const unmet: Unmet[] = [];
  for (const row of input.claimed) {
    const why = input.correctness.carried ? "carried" : (verdictShortfall(row, input.correctness, input) ?? (input.adversaryRequired ? adversaryShortfall(row, input) : undefined));
    if (why !== undefined) unmet.push({ step: row.step, closure: row.closure, why });
    if (why !== undefined) continue;
    const meeters = [input.correctness.reviewer, input.adversaryRequired ? input.adversary?.reviewer : undefined];
    met.push({ step: row.step, closure: row.closure, meeters: meeters.filter((agent) => agent !== undefined) });
  }
  return { met, unmet };
}
