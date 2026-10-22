import { liveField, type ConfigRef } from "./config-ref.js";
import type { ReviewConfig } from "./config.js";
import { DEFAULT_ACCOUNT, type ReviewAccounts } from "./shepherd/account-limit.js";
import { DEFAULT_ADVERSARY_PROFILE } from "./shepherd/review-panel-plan.js";
import type { ReviewWiring } from "./shepherd/review.js";
import type { AgentChatReviewerDispatch } from "./shepherd/reviewer-dispatch.js";
import type { SpawnLimits } from "./shepherd/spawn-gate.js";

/** The parts of the route wiring that read a live config row per use instead of once at start. */

type DispatchUnder = (configDir: string | undefined) => AgentChatReviewerDispatch;

type Accounts = { primary: AgentChatReviewerDispatch; accounts: ReviewAccounts };

/**
 * `review.configDir` first, then each fallback, read per use; every account gets its own dispatch over the one roster and
 * spawn gate, built the first time it is asked for and kept, so a fallback dropped and re-added keeps its dispatch.
 */
export function reviewAccounts(review: ReviewConfig, fallbacks: () => readonly string[] | undefined, under: DispatchUnder, alert: ReviewAccounts["alert"]): Accounts {
  const first = review.configDir ?? DEFAULT_ACCOUNT;
  const primary = under(review.configDir);
  const byDir = new Map([[first, primary]]);
  const dirs = () => [...new Set([first, ...(fallbacks() ?? [])])];
  const dispatchUnder = (dir: string): AgentChatReviewerDispatch => {
    if (!dirs().includes(dir)) return primary;
    const built = byDir.get(dir) ?? under(dir);
    byDir.set(dir, built);
    return built;
  };
  return { primary, accounts: { get dirs() { return dirs(); }, dispatchUnder, alert } };
}

/**
 * Decision 422(1)'s second reviewer: a g10-adversary hold gets its own adversary member unless `twoMergeRelease` is off or
 * absent. The mode and the profile are read per use; `adversaryConfigDir` is a restart key, so its dispatch is built once.
 */
type HoldAdversary = Pick<ReviewWiring, "holdMember" | "adversaryDispatch" | "twoMergeRelease">;

export function holdAdversary(review: ReviewConfig, config: ConfigRef, under: DispatchUnder): HoldAdversary {
  const twoMerge = liveField(config, "shepherd.gateReset.twoMergeRelease");
  const profile = liveField(config, "shepherd.review.adversaryProfile");
  const mode = () => {
    const value = twoMerge();
    return value === "off" ? undefined : value;
  };
  const dispatch = review.adversaryConfigDir === undefined ? undefined : under(review.adversaryConfigDir);
  return {
    get twoMergeRelease() {
      return mode();
    },
    get holdMember() {
      return mode() && { profile: profile() ?? DEFAULT_ADVERSARY_PROFILE };
    },
    get adversaryDispatch() {
      return mode() && dispatch;
    },
  };
}

/** `wiring` with the hold adversary's keys as getters over `adversary`, so a spread copy of the wiring does not fix them. */
export function withHoldAdversary<W extends object>(wiring: W, adversary: HoldAdversary): W & HoldAdversary {
  return {
    ...wiring,
    get twoMergeRelease() {
      return adversary.twoMergeRelease;
    },
    get holdMember() {
      return adversary.holdMember;
    },
    get adversaryDispatch() {
      return adversary.adversaryDispatch;
    },
  };
}

/** The live rows of the spawn limits; a row the reloaded file leaves out falls back to its default, not its startup value. */
export function liveSpawnLimits(startup: Partial<SpawnLimits>, config: ConfigRef): () => Partial<SpawnLimits> {
  const reads = {
    load5: liveField(config, "shepherd.spawnGate.load5"),
    buildLoad5: liveField(config, "shepherd.spawnGate.buildLoad5"),
    maxConcurrentReviews: liveField(config, "shepherd.review.maxConcurrent"),
  };
  const fixed = Object.fromEntries(Object.entries(startup).filter(([key]) => !(key in reads)));
  return () => ({ ...fixed, ...Object.fromEntries(Object.entries(reads).flatMap(([key, read]) => { const value = read(); return value === undefined ? [] : [[key, value]]; })) });
}
