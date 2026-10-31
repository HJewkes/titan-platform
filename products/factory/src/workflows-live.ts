import { DEFAULT_SONNET_FOR } from "@titan-design/review-panel";
import { liveField, type ConfigRef } from "./config-ref.js";
import type { ReviewConfig } from "./config.js";
import { accountsFrom } from "./shepherd/account-fallback.js";
import { DEFAULT_ACCOUNT, type ReviewAccounts } from "./shepherd/account-limit.js";
import { DEFAULT_ADVERSARY_PROFILE } from "./shepherd/review-panel-plan.js";
import type { ReviewWiring } from "./shepherd/review.js";
import type { AgentChatReviewerDispatch } from "./shepherd/reviewer-dispatch.js";
import type { SpawnLimits } from "./shepherd/spawn-gate.js";
import type { VisualThreshold } from "./shepherd/visual-delta-read.js";

/** The parts of the route wiring that read a live config row per use instead of once at start. */

type DispatchUnder = (configDir: string | undefined, fallbackConfigDirs?: () => readonly string[]) => AgentChatReviewerDispatch;

type Accounts = { primary: AgentChatReviewerDispatch; accounts: ReviewAccounts };

/**
 * `review.configDir` first, then each fallback, read per use; every account gets its own dispatch over the one roster and
 * spawn gate, built the first time it is asked for and kept, so a fallback dropped and re-added keeps its dispatch. A spawn the
 * broker refuses at an account's limit moves to the accounts after it (TP-4507).
 */
export function reviewAccounts(review: ReviewConfig, fallbacks: () => readonly string[] | undefined, under: DispatchUnder, alert: ReviewAccounts["alert"]): Accounts {
  const first = review.configDir ?? DEFAULT_ACCOUNT;
  const dirs = () => [...new Set([first, ...(fallbacks() ?? [])])];
  const after = (dir: string) => () => accountsFrom(dirs(), dir).slice(1);
  const primary = under(review.configDir, after(first));
  const byDir = new Map([[first, primary]]);
  const dispatchUnder = (dir: string): AgentChatReviewerDispatch => {
    if (!dirs().includes(dir)) return primary;
    const built = byDir.get(dir) ?? under(dir, after(dir));
    byDir.set(dir, built);
    return built;
  };
  return { primary, accounts: { get dirs() { return dirs(); }, dispatchUnder, alert } };
}

/**
 * A successor bills the review rotation (decision 514), read per wake: `shepherd.fixer.configDir`, when set, takes the place
 * of `review.configDir`, and `review.fallbackConfigDirs` follow. No review wired leaves the successor on `fixer.configDir`.
 */
export function successorAccounts(fixerConfigDir: string | undefined, accounts: Pick<ReviewAccounts, "dirs"> | undefined): (() => readonly string[]) | undefined {
  if (!accounts) return undefined;
  return () => (fixerConfigDir === undefined ? accounts.dirs : [...new Set([fixerConfigDir, ...accounts.dirs.slice(1)])]);
}

/**
 * Decision 422(1)'s second reviewer: a g10-adversary hold gets its own adversary member unless `twoMergeRelease` is off or
 * absent. The mode and the profile are read per use; `adversaryConfigDir` is a restart key, so its dispatch is built once.
 */
type HoldAdversary = Pick<ReviewWiring, "holdMember" | "adversaryDispatch" | "twoMergeRelease">;

/**
 * A configured adversary the hold could only dispatch to a refusal fails the config load: its profile, and the profile no
 * headroom lowers it to, must both be installed headless (tp#1986). An absent profile is the installed default's.
 */
function assertAdversaryProfile(review: Pick<ReviewConfig, "adversaryProfile">, installed: (profile: string) => boolean): void {
  const profile = review.adversaryProfile;
  if (profile === undefined) return;
  if (!installed(profile)) throw new Error(`invalid config: shepherd.review.adversaryProfile '${profile}' is not installed headless`);
  const lowered = Object.hasOwn(DEFAULT_SONNET_FOR, profile) ? DEFAULT_SONNET_FOR[profile] : undefined;
  if (lowered !== undefined && !installed(lowered)) throw new Error(`invalid config: shepherd.review.adversaryProfile '${profile}' would be lowered to '${lowered}', which is not installed headless`);
}

export function holdAdversary(review: ReviewConfig, config: ConfigRef, under: DispatchUnder, installed: (profile: string) => boolean): HoldAdversary {
  assertAdversaryProfile(review, installed);
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
    windowMs: liveField(config, "shepherd.spawnGate.windowMs"),
    headroomIntervalMs: liveField(config, "shepherd.spawnGate.headroomIntervalMs"),
    maxConcurrentReviews: liveField(config, "shepherd.review.maxConcurrent"),
  };
  const fixed = Object.fromEntries(Object.entries(startup).filter(([key]) => !(key in reads)));
  return () => ({ ...fixed, ...Object.fromEntries(Object.entries(reads).flatMap(([key, read]) => { const value = read(); return value === undefined ? [] : [[key, value]]; })) });
}

/** Read through the live config at each evidence step, so a threshold edit applies at the next head without a restart; repo keys match in any case. */
export function visualThresholdOf(config: ConfigRef): (repo: string) => VisualThreshold | undefined {
  return (repo) => Object.entries(config.get().shepherd?.visualThreshold ?? {}).find(([key]) => key.toLowerCase() === repo.toLowerCase())?.[1];
}
