import { z } from "zod";
import { attestationsFileOf } from "./attest-read.js";
import { LeaveLand } from "./leave-land.js";
import type { Verdict } from "./phases.js";

/**
 * How many heads a run sends back for a declined attestation before the owner's approve-merge gate decides instead: one
 * round for the implementer to replace the claim with a version bump, then the gate as before (TP-5689).
 */
const ATTEST_SEND_BACKS = 1;

const NO_MEETER = "no-meeter";
/** Step names come from the PR's own attestations file, so only registry-shaped names reach the implementer's brief. */
const STEP_NAME = /^[a-z0-9-]{1,64}$/;
const ATTEST_DECLINED = "ATTEST_DECLINED";

const UnmetEvidence = z.looseObject({ attest: z.looseObject({ unmet: z.array(z.looseObject({ step: z.string(), why: z.string() })).min(1) }) });
const AttestDeclinedPayload = z.looseObject({ kind: z.literal(ATTEST_DECLINED), steps: z.array(z.string()).min(1), file: z.string() });
type AttestDeclinedPayload = z.infer<typeof AttestDeclinedPayload>;

/**
 * The steps whose rows only the correctness reviewer's missing token left unmet, for a MERGE at exactly `headSha`; empty
 * when any row is unmet for another reason (an author meeter, a closure mismatch, a missing adversary, an unread file),
 * which keep the owner's gate.
 */
function declinedSteps(verdict: Verdict | undefined, headSha: string): string[] {
  if (verdict?.kind !== "MERGE" || verdict.headSha !== headSha) return [];
  const evidence = UnmetEvidence.safeParse(verdict.evidence);
  if (!evidence.success) return [];
  const { unmet } = evidence.data.attest;
  if (!unmet.every(({ why, step }) => why === NO_MEETER && STEP_NAME.test(step))) return [];
  return [...new Set(unmet.map(({ step }) => step))];
}

/** Heads other than `headSha` this run already sent back for a declined attestation, read from its reviews so a replay keeps the count. */
function attestSendBacksBefore(reviews: ReadonlyMap<string, Verdict>, headSha: string): number {
  return [...reviews].filter(([head, verdict]) => head !== headSha && declinedSteps(verdict, head).length > 0).length;
}

const attestDeclined = (pr: number, steps: readonly string[]): AttestDeclinedPayload => ({ kind: ATTEST_DECLINED, steps: [...steps], file: attestationsFileOf(pr) });

type Wake = (payload: unknown) => Promise<boolean>;

/**
 * True goes on to the merge decision as before. A MERGE whose reviewer declined to attest a claimed step first goes back
 * to the implementer through `wake` to replace the claim with a version bump, once per run; a taken wake leaves the land
 * round, and an unhandled wake or a second decline asks the owner as before.
 */
export async function attestDeclineRoute(reviews: ReadonlyMap<string, Verdict>, pr: number, routed: { headSha: string; verdict: Verdict }, wake: Wake): Promise<boolean> {
  const { headSha, verdict } = routed;
  const steps = declinedSteps(verdict, headSha);
  if (steps.length === 0 || attestSendBacksBefore(reviews, headSha) >= ATTEST_SEND_BACKS) return true;
  if (await wake(attestDeclined(pr, steps))) throw new LeaveLand();
  return true;
}

/** The implementer's brief for a declined attestation; undefined for any other review payload. */
export function attestDeclinedWake(headSha: string, payload: unknown): { reason: string; payload: string } | undefined {
  const declined = AttestDeclinedPayload.safeParse(payload);
  if (!declined.success) return undefined;
  const steps = declined.data.steps.join(", ");
  const reason = [
    `The independent review of head ${headSha} said MERGE but did not attest that ${steps} behave as before, so the PR's "no semantic change" claim for them stands unmet.`,
    `Remove those rows from \`${declined.data.file}\`, bump each step's version in the factory registry, and run \`pnpm registry:closure --write\`.`,
    "If you can show the behaviour is unchanged instead, say how in your final message; the next head gets a fresh review either way.",
  ].join(" ");
  return { reason, payload: `Steps the reviewer did not attest: ${steps}` };
}
