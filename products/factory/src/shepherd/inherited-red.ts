import type { AwaitHeadTiming } from "../workflows/await-head.js";
import { decideHoldOrPass } from "./freeze-hold.js";
import type { FreezeStore } from "./freeze.js";
import type { ShepherdDeps } from "./phases.js";

/** An unchanged base is weighed again after this long, so a base whose CI finished late still releases the wait. */
export const INHERITED_IDLE_MS = 30 * 60_000;

type InheritedRed = NonNullable<AwaitHeadTiming["inheritedRed"]>;

/**
 * The await-new-head hook that re-runs the base-red hold decision for a ci-red head the fixer left unchanged: true once
 * every failing check is the base's red, a stale base's or a frozen main's. A full decision runs only when the base head
 * moved or `INHERITED_IDLE_MS` passed; any read that fails answers false, so the wait goes on as before.
 */
export function inheritedRedCheck(deps: ShepherdDeps, freezes: (() => FreezeStore) | undefined): InheritedRed {
  return (target) => {
    let last: { baseSha: string; at: number } | undefined;
    return async (pr) => {
      const baseSha = await deps.port.getHeadSha(target.repo, pr.baseRef).catch(() => null);
      if (baseSha === null) return false;
      const at = deps.now();
      if (last?.baseSha === baseSha && at - last.at < INHERITED_IDLE_MS) return false;
      last = { baseSha, at };
      const red = { headSha: target.headSha, failing: target.failing ?? [], ...(target.mainFixedSpent === true && { mainFixedSpent: true }) };
      const hold = await decideHoldOrPass(deps, freezes, { repo: target.repo, pr: target.pr, ...red });
      return hold.hold;
    };
  };
}
