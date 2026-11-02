import { visibleLines } from "@titan-design/session-read";

/** The line a reviewer writes above its verdict block to attest that a step's behaviour is unchanged at this closure. */
export const ATTESTS_HEADING = "Attests:";

/** One row a PR claims in its attestations file: the step and the closure its behaviour is said not to change. */
export interface AttestClaim {
  step: string;
  closure: string;
}

const ATTEST_TOKEN = /^[a-z0-9-]+@[0-9a-f]{12}$/;
const CLAIM_STEP = /^[a-z0-9-]+$/;
const CLAIM_CLOSURE = /^[0-9a-f]{12,64}$/;
/** The claims come from a file the PR's author wrote, so only a bounded, grammar-valid list reaches the prompt. */
export const MAX_ATTEST_CLAIMS = 8;

/**
 * The tokens of the last visible `Attests:` line above the Verdict line, one per step. A malformed token is dropped, not
 * refused: it meets nothing, so the merge guard gates and no correction round is spent on it.
 */
export function attestTokens(text: string): string[] {
  const lines = visibleLines(text);
  const verdictAt = lines.findIndex((line) => line?.startsWith("Verdict:"));
  const above = lines.slice(0, verdictAt < 0 ? 0 : verdictAt);
  const line = above.filter((candidate) => candidate?.startsWith(ATTESTS_HEADING)).at(-1);
  if (!line) return [];
  const tokens = line.slice(ATTESTS_HEADING.length).split(",").map((token) => token.trim()).filter((token) => ATTEST_TOKEN.test(token));
  const byStep = new Map<string, string>();
  for (const token of tokens) if (!byStep.has(stepOf(token))) byStep.set(stepOf(token), token);
  return [...byStep.values()];
}

const stepOf = (token: string): string => token.slice(0, token.indexOf("@"));

const validClaims = (claims: readonly AttestClaim[]): AttestClaim[] =>
  claims.filter(({ step, closure }) => CLAIM_STEP.test(step) && CLAIM_CLOSURE.test(closure)).slice(0, MAX_ATTEST_CLAIMS);

/** Empty when no claim is valid; a MERGE without the line still counts for the code, it just attests nothing. */
export function attestRule(claims: readonly AttestClaim[]): string[] {
  const valid = validClaims(claims);
  if (valid.length === 0) return [];
  const named = valid.map(({ step, closure }) => `${step} (closure ${closure.slice(0, 12)})`).join(", ");
  const tokens = valid.map(({ step, closure }) => `${step}@${closure.slice(0, 12)}`).join(", ");
  return [
    `This PR claims no semantic change for ${named}. If you have verified that a step's behaviour is unchanged, add above the Verdict line the line \`${ATTESTS_HEADING} ${tokens}\`, keeping only the steps you verified. Omit it otherwise; your MERGE still counts for the code.`,
  ];
}
