import type { ReviewTarget, ReviewerAgent } from "@titan-design/review-panel";
import { freshReviewerBase } from "./cleanup.js";
import { adoptedReviewer } from "./external-review.js";
import { provablyIndependent, type Lineage } from "./lineage.js";
import type { Registration } from "./store.js";

/** A standing reviewer holding this much context or more is not resumed. */
export const MAX_RESUME_FILL_TOKENS = 300_000;

/** Which reviewer a head gets, before the intent step stamps its head and time. */
type ReviewerChoice = { mode: "spawn" | "resume" | "external"; reviewer: string; agentId?: string };

/** The registration's opt-in reviewer, only when it is provably independent of the implementer, has ended, and has room left. */
function standingReviewer(registration: Registration | undefined, roster: readonly ReviewerAgent[], lineage: Lineage): ReviewerAgent | undefined {
  const name = registration?.policy.reviewer;
  if (registration === undefined || name === undefined) return undefined;
  const named = roster.filter((agent) => agent.name === name);
  const agent = named[0];
  if (named.length !== 1 || agent === undefined) return undefined;
  const resumable = agent.presence === "exited" && agent.sessionId !== "" && agent.fillTokens !== undefined && agent.fillTokens < MAX_RESUME_FILL_TOKENS;
  return resumable && provablyIndependent(agent, registration.implementer, lineage) ? agent : undefined;
}

const UNPROVEN: Lineage = { rows: [], complete: false };

/**
 * The lineage `chooseReviewer` proves a standing reviewer against, read only when the registration names one. No reader
 * wired means the roster stands for the whole lineage; a failed read proves nothing, so the reviewer is spawned fresh.
 */
export async function lineageFor(read: (() => Promise<Lineage>) | undefined, registration: Registration | undefined, roster: readonly ReviewerAgent[]): Promise<Lineage> {
  if (read === undefined) return { rows: roster, complete: true };
  if (registration?.policy.reviewer === undefined) return UNPROVEN;
  return read().catch((error: unknown) => {
    console.warn(`shepherd: the lineage could not be read, so no standing reviewer is resumed: ${error instanceof Error ? error.message : String(error)}`);
    return UNPROVEN;
  });
}

/** A name no agent in the roster has held, so a fresh reviewer is never confused with an earlier agent. */
function freshName(target: ReviewTarget, implementer: string | undefined, roster: readonly ReviewerAgent[]): string {
  const taken = new Set([...roster.map((agent) => agent.name), implementer]);
  const base = freshReviewerBase(target.repo, target.pr);
  for (let k = 1; ; k += 1) {
    const name = k === 1 ? base : `${base}-${k}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * A hold that names a reviewer waits for that reviewer, unless its class needs Shepherd's own review too or a seat asked for
 * one at this head, taken or not, so a retry of the asked review is Shepherd's own too; `fresh` skips the standing reviewer,
 * which may be the one that went silent. Only `roster` names a reviewer; `lineage` only proves one independent.
 */
export function chooseReviewer(target: ReviewTarget, registration: Registration | undefined, roster: readonly ReviewerAgent[], lineage: Lineage, fresh = false): ReviewerChoice {
  const asked = registration?.reviewRequest?.head === target.head;
  const external = asked ? undefined : adoptedReviewer(registration);
  if (external) return { mode: "external", reviewer: external };
  if (asked) return { mode: "spawn", reviewer: freshName(target, registration.implementer, roster) };
  const standing = fresh ? undefined : standingReviewer(registration, roster, lineage);
  if (standing) return { mode: "resume", reviewer: standing.name, agentId: standing.agentId };
  return { mode: "spawn", reviewer: freshName(target, registration?.implementer, roster) };
}
