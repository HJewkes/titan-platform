import type { GitHubPort } from "@titan-design/github";
import { EXIT } from "@titan-design/registry";
import type { GateBatchStore } from "../gate-batch-store.js";
import { ownerRelease } from "../shepherd/owner-release.js";
import type { ShepherdStore } from "../shepherd/store.js";
import { consoleResolver, githubOutcome, refused, type Outcome } from "./outcome.js";
import type { Read, ReleaseAction } from "./record.js";

interface ReleaseDeps {
  store: ShepherdStore;
  port: GitHubPort;
  batches: GateBatchStore;
}

/**
 * Lifts the owner-asked hold on the record's PR, and only that hold, at the head the owner confirmed. Shepherd's own
 * checks run again inside `ownerRelease`; reading them first here is what lets the console tell moved from gone.
 */
export async function releaseHold({ action, confirmEvent }: Read<ReleaseAction>, port: GitHubPort, store: ShepherdStore, batches: GateBatchStore): Promise<Outcome> {
  const registration = store.byPr(action.repo, action.pr);
  if (registration === undefined) return { outcome: "gone", reason: `${action.repo}#${action.pr} is not registered with shepherd` };
  const { runId } = registration;
  const before = releasedBefore(store, runId, confirmEvent);
  if (before !== undefined) return before;
  if (registration.ownerHold === null) return { outcome: "gone", reason: `${action.repo}#${action.pr} holds no owner-asked hold` };
  const stale = await githubOutcome(port, action);
  return stale ?? releaseOnce({ store, port, batches }, { ...action, runId }, confirmEvent);
}

/**
 * `already` only when this very record lifted a hold: `ownerRelease` writes the resolver's proof into the event's actor. Read
 * before the hold state, so one confirmation never lifts a newer owner-asked hold placed after it.
 */
function releasedBefore(store: ShepherdStore, runId: string, confirmEvent: string): Outcome | undefined {
  const actor = `owner-remote:titan-console proof ${confirmEvent}`;
  return store.eventsOf(runId).some((event) => event.kind === "release" && event.actor === actor) ? { outcome: "already", runId } : undefined;
}

/** Of two concurrent posts of one record only one lifts the hold; the other loses inside `ownerRelease` and reads back `already`. */
async function releaseOnce({ store, port, batches }: ReleaseDeps, { repo, pr, headSha, runId }: ReleaseAction & { runId: string }, confirmEvent: string): Promise<Outcome> {
  try {
    const after = await ownerRelease(store, port, { repo, pr, head: headSha }, consoleResolver(confirmEvent), batches);
    return { outcome: "released", runId, stillHeld: after.held ? after.holdReason : null };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code === EXIT.NOPERM) return refused("resolver", message);
    if (code === EXIT.UNAVAILABLE) return refused("github-unreadable", message);
    if (error instanceof Error && "currentHead" in error && typeof error.currentHead === "string") return { outcome: "moved", currentHead: error.currentHead };
    if (code === EXIT.DATAERR || code === EXIT.NOINPUT) return releasedBefore(store, runId, confirmEvent) ?? { outcome: "gone", reason: message };
    throw error;
  }
}
