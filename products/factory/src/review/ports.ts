import { setTimeout as sleep } from "node:timers/promises";
import type { GitHubPort } from "@titan-design/github";
import type { ReviewTarget } from "@titan-design/review-panel";
import type { CheckoutState, ParkingPort, ReviewBodyPorts } from "@titan-design/review-workflow";
import type { FactoryConfig, ReviewConfig } from "../config.js";
import { agentChatAgents, installedHeadless } from "../shepherd/agents.js";
import { DEFAULT_DIAGNOSIS_PROFILE } from "../shepherd/no-verdict-diagnosis.js";
import { reviewCheckoutDisk } from "../shepherd/review-checkout-disk.js";
import { removeReviewCheckout } from "../shepherd/review-checkout.js";
import { agentChatReviewerDispatch } from "../shepherd/reviewer-dispatch.js";
import { transcriptReviewerReader } from "../shepherd/reviewer-reader.js";
import { configuredRoles } from "../shepherd/reviewer-roles.js";
import { DEFAULT_SPAWN_LIMITS } from "../shepherd/spawn-gate.js";
import { boundCheckout, loadSeatBook } from "../shepherd/seats.js";
import type { CiRead } from "./format.js";
import { ghLineSource } from "./gh-line-source.js";
import { prProofReader, snapshotReader } from "./head-reads.js";

type Shepherd = NonNullable<FactoryConfig["shepherd"]>;

/** What the CLI's ports are built from: the config's review settings, the checkout root, and a store for parked runs. */
export interface ReviewPortsConfig {
  shepherd: Shepherd & { review: ReviewConfig; agentChatBin: string };
  checkoutRoot: string;
  parking: ParkingPort;
  port: GitHubPort;
  /** Hears where each snapshot's CI state came from. */
  onCi?: (target: ReviewTarget, ci: CiRead) => void;
}

/**
 * The CLI reviews one PR at a time, so the target the last snapshot read named is the one under review. The source and
 * fixer ports take no target, so they follow it; that is what lets one runner resolve runs parked on several PRs.
 */
function followedTarget() {
  let current: ReviewTarget | undefined;
  return {
    set: (target: ReviewTarget) => void (current = target),
    get: (): ReviewTarget => {
      if (current === undefined) throw new Error("no review target has been read yet");
      return current;
    },
  };
}

/** One gh reader per head, so a head's reads stay memoized and capped as `ghLineSource` intends. */
function followedSource(target: ReturnType<typeof followedTarget>): ReviewBodyPorts["source"] {
  let at: { key: string; source: ReturnType<typeof ghLineSource> } | undefined;
  return {
    lines: (path) => {
      const { repo, head } = target.get();
      if (at?.key !== `${repo}@${head}`) at = { key: `${repo}@${head}`, source: ghLineSource(repo, head) };
      return at.source.lines(path);
    },
  };
}

function checkoutState(root: string, review: ReviewConfig): () => CheckoutState {
  const read = reviewCheckoutDisk(root);
  const minBytes = review.minFreeBytes ?? DEFAULT_SPAWN_LIMITS.reviewMinFreeBytes;
  const minPct = review.minFreeInodesPct ?? DEFAULT_SPAWN_LIMITS.reviewMinFreeInodesPct;
  return () => {
    const disk = read();
    const freeBytes = disk.freeBytes ?? Number.POSITIVE_INFINITY;
    const freeInodesPct = disk.totalInodes ? (100 * (disk.freeInodes ?? 0)) / disk.totalInodes : 100;
    return freeBytes < minBytes || freeInodesPct < minPct ? { kind: "low-disk", freeBytes, freeInodesPct } : { kind: "ready" };
  };
}

function cwdOf(shepherd: Shepherd): (repo: string) => string | undefined {
  return (repo) => boundCheckout(loadSeatBook(shepherd), repo, shepherd.repos ?? {});
}

/** Every port the workflow reads through, over the configured agent-chat and GitHub; the fixer only ever proposes. */
export function reviewPorts(config: ReviewPortsConfig): ReviewBodyPorts {
  const { shepherd, checkoutRoot } = config;
  const { review, agentChatBin } = shepherd;
  const { port } = config;
  const target = followedTarget();
  const cwdFor = cwdOf(shepherd);
  const dispatch = agentChatReviewerDispatch({ agentChatBin, roles: configuredRoles(review), configDir: review.configDir, fallbackConfigDirs: () => review.fallbackConfigDirs ?? [], cwdFor });
  const agents = agentChatAgents(agentChatBin, { configDir: review.configDir });
  const checkout = checkoutState(checkoutRoot, review);
  const snapshot = snapshotReader(port, config.onCi);
  return {
    snapshot: { read: async (read) => (target.set(read), snapshot.read(read)) },
    proofReader: prProofReader(port),
    carry: { probe: async () => ({ kind: "no-carry" }) },
    checkout: { state: async () => checkout(), refresh: async (at) => void (await removeReviewCheckout(checkoutRoot, at)) },
    dispatch,
    reader: transcriptReviewerReader({ roster: dispatch.roster }),
    source: followedSource(target),
    fixer: { roster: () => dispatch.roster(), spawn: (name, brief) => agents.spawn({ name, profile: DEFAULT_DIAGNOSIS_PROFILE, brief, cwd: fixerCwd(cwdFor, target.get().repo) }) },
    clock: { now: Date.now, sleep: (ms) => sleep(ms) },
    headroom: { read: async () => ({ opus: true, account: "available" }) },
    profiles: { installed: (profile) => installedHeadless(profile) },
    parking: config.parking,
  };
}

function fixerCwd(cwdFor: (repo: string) => string | undefined, repo: string): string {
  const cwd = cwdFor(repo);
  if (cwd === undefined) throw new Error(`no checkout of ${repo} is bound in the factory config, so its fixer has nowhere to start`);
  return cwd;
}
