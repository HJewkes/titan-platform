import type { GitHubPort } from "@titan-design/github";
import type { PrSnapshot } from "../workflows/pr-snapshot.js";
import { advisoryGuard, type IsAdvisory } from "./advisory.js";
import { isFixersPr, repoFrozenReason, type FreezeGuard, type FreezeStore } from "./freeze.js";
import { firstReason, heldCheck, type HeldCheck } from "./hold.js";
import { releaseGuard } from "./release.js";
import type { ShepherdStore } from "./store.js";

interface ShadowHeldDeps {
  port: GitHubPort;
  holds: () => ShepherdStore;
  freezes: () => FreezeStore;
  advisory: IsAdvisory;
  now?: () => number;
  snapshot?: PrSnapshot;
}

/** A freeze as it stands, with no recheck of the default branch, since a recheck claims its slot and can thaw the repo. */
function standingFreeze(deps: ShadowHeldDeps): FreezeGuard {
  return {
    reason: async (_port, repo, pr) => {
      const manual = repoFrozenReason(deps.freezes(), repo);
      if (manual !== undefined) return manual;
      const freeze = deps.freezes().get(repo);
      return freeze && !isFixersPr(freeze, deps.holds().byPr(repo, pr)) ? `${repo} is frozen: main is red at ${freeze.redSha}` : undefined;
    },
  };
}

/**
 * The hold check the train shadow reads, which writes nothing. It has no satisfier, because a satisfier can satisfy or
 * withdraw a hold. It has no adversary guard, because that guard can re-hold a PR. A satisfaction the merge step would
 * newly record reads here as still held.
 */
export function shadowHeldCheck(deps: ShadowHeldDeps): HeldCheck {
  const guard = firstReason(advisoryGuard(deps.advisory), standingFreeze(deps), releaseGuard(deps.holds, deps.now));
  return heldCheck(deps.port, deps.holds, guard, undefined, deps.snapshot);
}
