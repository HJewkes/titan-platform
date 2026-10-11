import type { RepoSlug } from "@titan-design/github";
import { releasedAdversaryAt, reholdReason } from "./adversary-anchor.js";
import { SHEPHERD_ACTOR } from "./events.js";
import type { FreezeGuard } from "./freeze.js";
import type { TakeRehold } from "./hold.js";
import { isCleanMergeUpOf } from "./merge-up-carry.js";
import type { ShepherdStore } from "./store.js";
import type { CarryInput, CarryResult } from "./tree-carry.js";

interface AdversaryGuardDeps {
  store: () => ShepherdStore;
  /** The `sh-carry` probe; one that throws or cannot say counts as a move. */
  carry: (input: CarryInput) => Promise<CarryResult>;
}

interface AdversaryGuard extends FreezeGuard {
  /** Ends a merge wait once after this guard re-held the PR, so the run's next CI read tells the seat. */
  takeRehold: TakeRehold;
}

const prKey = (repo: RepoSlug, pr: number): string => `${repo.toLowerCase()}#${pr}`;

/**
 * The merge-time half of the g10-adversary re-hold: every merge passes here, so a head the seat's adversary review never
 * saw cannot land, whichever path released the run's other holds and however the CI reads fell. A head passes only when
 * it is the head of the last `g10-adversary` release or a clean merge-up of it. Any other head is re-held here, by a
 * compare-and-swap; a lost swap still refuses this merge, and the next check reads the run again.
 */
export function adversaryGuard(deps: AdversaryGuardDeps): AdversaryGuard {
  const clean = new Set<string>();
  const reheld = new Set<string>();
  return {
    async reason(_port, repo, pr, baseRef, head) {
      const store = deps.store();
      const registration = store.byPr(repo, pr);
      if (!registration || head === undefined) return undefined;
      const mark = store.changeMark(registration.runId);
      const released = releasedAdversaryAt(store.eventsOf(registration.runId));
      if (!released || released === head || clean.has(`${released}>${head}`)) return undefined;
      const result = await deps.carry({ repo, baseRef, fromHead: released, head }).catch((): CarryResult => ({ equal: false }));
      if (isCleanMergeUpOf(result, new Set([released]))) return void clean.add(`${released}>${head}`);
      const reason = reholdReason(released, head);
      if (store.holdIfUnchanged(registration.runId, mark, reason, { actor: SHEPHERD_ACTOR, headSha: head })) reheld.add(prKey(repo, pr));
      return reason;
    },
    takeRehold: (repo, pr) => reheld.delete(prKey(repo, pr)),
  };
}
