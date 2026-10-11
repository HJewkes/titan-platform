import type { RepoSlug } from "@titan-design/github";
import { adversaryRehold } from "./adversary-anchor.js";
import { SHEPHERD_ACTOR } from "./events.js";
import type { FreezeGuard } from "./freeze.js";
import type { TakeRehold } from "./hold.js";
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
 * saw cannot land, whichever path released the run's other holds and however the CI reads fell. `adversaryRehold` judges
 * the head; one it does not vouch for is re-held here, by a compare-and-swap. A lost swap still refuses this merge, and the
 * next check reads the run again. A run registered only by its branch, still waiting for its PR, is found by the head branch.
 */
export function adversaryGuard(deps: AdversaryGuardDeps): AdversaryGuard {
  const reheld = new Set<string>();
  return {
    async reason(_port, repo, pr, baseRef, head, branch) {
      const store = deps.store();
      const registration = store.byPr(repo, pr) ?? (branch === undefined ? undefined : store.byBranch(repo, branch));
      if (!registration || head === undefined) return undefined;
      const rehold = await adversaryRehold(store, registration.runId, head, (released) => deps.carry({ repo, baseRef, fromHead: released, head }));
      if (!rehold) return undefined;
      if (store.holdIfUnchanged(registration.runId, rehold.mark, rehold.reason, { actor: SHEPHERD_ACTOR, headSha: head })) reheld.add(prKey(repo, pr));
      return rehold.reason;
    },
    takeRehold: (repo, pr) => reheld.delete(prKey(repo, pr)),
  };
}
