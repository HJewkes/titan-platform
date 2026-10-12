import type { ReviewTarget } from "@titan-design/review-panel";
import { registeredKind } from "./merge-facts.js";
import type { ShepherdDeps } from "./phases.js";
import { everG10Held } from "./registration-hold.js";
import { prChangedLines, prTouchesDependency, type ReviewerFacts, type ReviewerRoles } from "./reviewer-roles.js";

/** The part of a review intent that decides whether the PR is sized: only a spawn picks a profile. */
interface SpawnIntent {
  mode: string;
  at: number;
}

/** A step with no run id, or a store that cannot be read, has no kind or hold to go by, so it is classed with the stricter reviewers. */
function reviewerFacts(deps: ShepherdDeps, runId: string | undefined): ReviewerFacts {
  const read = runId === undefined ? { unread: "no run id" } : registeredKind(deps.store, runId);
  const g10Hold = runId === undefined ? undefined : g10HoldRead(deps, runId);
  if (read.unread !== undefined || g10Hold === undefined) return { unread: true };
  return { ...(read.kind !== undefined && { kind: read.kind }), ...(g10Hold && { g10Hold }) };
}

/** Undefined when the store cannot be read. */
function g10HoldRead(deps: ShepherdDeps, runId: string): boolean | undefined {
  try {
    return everG10Held(deps.store.get(), runId);
  } catch {
    return undefined;
  }
}

/** A list that is truncated, unreadable or missing a count is no size, and an unread size takes the stricter class. */
async function sizeFacts(deps: ShepherdDeps, { repo, pr }: ReviewTarget, limit: number | undefined): Promise<ReviewerFacts> {
  try {
    const files = await deps.port.listPrFiles(repo, pr);
    const changedLines = prChangedLines(files, limit);
    const dependency = prTouchesDependency(files) && { dependencyTouch: true };
    return changedLines === undefined ? { sizeUnread: true, ...dependency } : { changedLines, ...dependency };
  } catch {
    return { sizeUnread: true };
  }
}

/** Only a spawn picks a profile, so only a spawn reads the PR's size. */
export async function spawnFacts(deps: ShepherdDeps, runId: string | undefined, intent: SpawnIntent, target: ReviewTarget, roles: ReviewerRoles | undefined): Promise<ReviewerFacts> {
  const facts = reviewerFacts(deps, runId);
  return intent.mode === "spawn" ? { ...facts, intentAt: intent.at, ...(await sizeFacts(deps, target, roles?.g10ChangedLines)) } : facts;
}
