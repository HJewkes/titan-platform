import { z } from "zod";
import { attestationsFileOf } from "./attest-read.js";
import type { Verdict } from "./phases.js";

/**
 * How many heads a run sends back for a declined attestation before the owner's approve-merge gate decides instead: one
 * round for the implementer to replace the claim with a version bump, then the gate as before (TP-5689).
 */
export const ATTEST_SEND_BACKS = 1;

/** The judge's reasons for a reviewer that answered MERGE at the head but named no token for the step, by who declined (TP-5902). */
type Decliner = "correctness" | "adversary";
const DECLINER = new Map<string, Decliner>([["no-meeter", "correctness"], ["adversary-declined", "adversary"]]);
/** Step names come from the PR's own attestations file, so only registry-shaped names reach the implementer's brief. */
const STEP_NAME = /^[a-z0-9-]{1,64}$/;
const ATTEST_DECLINED = "ATTEST_DECLINED";

interface DeclinedStep {
  step: string;
  by: Decliner;
}

const UnmetEvidence = z.looseObject({ attest: z.looseObject({ unmet: z.array(z.looseObject({ step: z.string(), why: z.string() })).min(1) }) });
/** `adversary` lists the steps the adversary declined; a payload recorded before TP-5902 has none, as only the correctness reviewer's decline was sent back. */
const AttestDeclinedPayload = z.looseObject({ kind: z.literal(ATTEST_DECLINED), steps: z.array(z.string()).min(1), file: z.string(), adversary: z.array(z.string()).optional() });
type AttestDeclinedPayload = z.infer<typeof AttestDeclinedPayload>;

/**
 * The steps whose rows only a reviewer's missing token left unmet, the correctness reviewer's or the adversary's, for a
 * MERGE at exactly `headSha`; empty when any row is unmet for another reason (an author meeter, a closure mismatch, no
 * adversary verdict at all, an unread file), which keep the owner's gate.
 */
export function declinedSteps(verdict: Verdict | undefined, headSha: string): DeclinedStep[] {
  if (verdict?.kind !== "MERGE" || verdict.headSha !== headSha) return [];
  const evidence = UnmetEvidence.safeParse(verdict.evidence);
  if (!evidence.success) return [];
  const declined = evidence.data.attest.unmet.map(({ why, step }) => ({ step, by: DECLINER.get(why) }));
  if (!declined.every((row): row is DeclinedStep => row.by !== undefined && STEP_NAME.test(row.step))) return [];
  return declined.filter((row, index) => declined.findIndex((seen) => seen.step === row.step) === index);
}

/** Heads other than `headSha` this run already sent back for a declined attestation, read from its reviews so a replay keeps the count. */
export function attestSendBacksBefore(reviews: ReadonlyMap<string, Verdict>, headSha: string): number {
  return [...reviews].filter(([head, verdict]) => head !== headSha && declinedSteps(verdict, head).length > 0).length;
}

export function attestDeclined(pr: number, declined: readonly DeclinedStep[]): AttestDeclinedPayload {
  const adversary = declined.filter(({ by }) => by === "adversary").map(({ step }) => step);
  return { kind: ATTEST_DECLINED, steps: declined.map(({ step }) => step), file: attestationsFileOf(pr), ...(adversary.length > 0 && { adversary }) };
}

/** Who declined which steps, the correctness reviewer first; a group with no steps is left out. */
function decliners({ steps, adversary = [] }: AttestDeclinedPayload): { who: string; steps: string }[] {
  const groups = [
    { who: "independent reviewer", steps: steps.filter((step) => !adversary.includes(step)) },
    { who: "adversary", steps: steps.filter((step) => adversary.includes(step)) },
  ];
  return groups.filter((group) => group.steps.length > 0).map(({ who, steps: named }) => ({ who, steps: named.join(", ") }));
}

/** The implementer's brief for a declined attestation, naming which reviewer declined; undefined for any other review payload. */
export function attestDeclinedWake(headSha: string, payload: unknown): { reason: string; payload: string } | undefined {
  const declined = AttestDeclinedPayload.safeParse(payload);
  if (!declined.success) return undefined;
  const groups = decliners(declined.data);
  const unattested = groups.map(({ who, steps }) => `the ${who} did not attest that ${steps}`).join(" and ");
  const reason = [
    `The review of head ${headSha} said MERGE, but ${unattested} behave as before, so the PR's "no semantic change" claim for them stands unmet.`,
    `Remove those rows from \`${declined.data.file}\`, bump each step's version in the factory registry, and run \`pnpm registry:closure --write\`.`,
    "If you can show the behaviour is unchanged instead, say how in your final message; the next head gets a fresh review either way.",
  ].join(" ");
  return { reason, payload: groups.map(({ who, steps }) => `Steps the ${who} did not attest: ${steps}`).join("\n") };
}
