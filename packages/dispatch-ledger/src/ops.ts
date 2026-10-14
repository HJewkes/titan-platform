import { PHASE_TIMEOUT_MS, type Claim, type Ledger, type Phase, type StackedOn } from "./schema.js";

/** A claim's identity: one claim per `(task, slice)` while it is held. */
export type ClaimKey = Pick<Claim, "taskId" | "slice">;

export const claimKey = (c: ClaimKey): string => `${c.taskId}#${c.slice ?? ""}`;

export const heldClaims = (ledger: Ledger): Claim[] => ledger.claims.filter((c) => c.phase !== "done");

const LANE_PHASES: ReadonlySet<Phase> = new Set(["spawning", "planning", "implementing", "reviewing"]);

/** Claims with an agent at work: parked, queued, awaiting-merge and shepherding claims hold their task but not a lane. */
export const laneClaims = (ledger: Ledger): Claim[] => ledger.claims.filter((c) => LANE_PHASES.has(c.phase));

/** The seat's claims the ledger shows holding an implementer: implementing, or spawning into it. */
export const ledgerImplementers = (ledger: Ledger, seat: string): number =>
  heldClaims(ledger).filter(
    (c) => c.seat === seat && (c.phase === "implementing" || (c.phase === "spawning" && c.nextPhase === "implementing")),
  ).length;

/** How many claims the ledger may hold beyond the agents actually running before the count is flagged. */
export const SLOT_MISMATCH_TOLERANCE = 3;

/** The flag shown beside a role count whose ledger runs more than the tolerance ahead of its live agents. */
export const slotMismatch = (ledger: number, live: number): string | undefined =>
  ledger - live > SLOT_MISMATCH_TOLERANCE ? `MISMATCH ledger ${ledger} vs ${live} live` : undefined;

export function isStalled(claim: Claim, now: Date): boolean {
  if (claim.stalledReason !== undefined) return true;
  const timeout = PHASE_TIMEOUT_MS[claim.phase];
  return timeout !== undefined && now.getTime() - Date.parse(claim.phaseAt) > timeout;
}

export const sameClaim = (a: ClaimKey, b: ClaimKey): boolean => a.taskId === b.taskId && a.slice === b.slice;

/** A second claim on a held `(task, slice)` is refused rather than merged. */
export function addClaim(ledger: Ledger, claim: Claim): Ledger {
  if (heldClaims(ledger).some((c) => sameClaim(c, claim))) {
    const slice = claim.slice === undefined ? "" : ` slice ${claim.slice}`;
    throw new Error(`task ${claim.taskId}${slice} is already claimed`);
  }
  return { ...ledger, claims: [...ledger.claims, claim] };
}

/** The parent a queued slice may stack on for its one unmet dependency `dep`, else undefined. */
export type StackPredicate = (child: Claim, dep: string) => StackedOn | undefined;

/**
 * Queued slices whose dependencies are all done or released, whose task is not in `held`, and that no
 * hand-dispatched PR is linked to, in ledger order. With `stack`, a slice with exactly one unmet dependency is
 * ready too when `stack` admits it, and comes back carrying `stackedOn`.
 */
export function readySlices(
  ledger: Ledger,
  held: ReadonlyMap<string, unknown> = new Map(),
  stack?: StackPredicate,
): Claim[] {
  const met = (taskId: string, slice: string): boolean =>
    ledger.slicesReleased?.[taskId]?.includes(slice) === true ||
    ledger.claims.some((c) => c.taskId === taskId && c.slice === slice && c.phase === "done");
  return ledger.claims.flatMap((c) => {
    if (c.phase !== "queued" || c.pr !== undefined || held.has(c.taskId)) return [];
    const unmet = (c.dependsOn ?? []).filter((dep) => !met(c.taskId, dep));
    if (unmet.length === 0) return [c];
    const [only] = unmet;
    const parent = unmet.length === 1 && only !== undefined && stack !== undefined ? stack(c, only) : undefined;
    return parent === undefined ? [] : [{ ...c, stackedOn: parent }];
  });
}
