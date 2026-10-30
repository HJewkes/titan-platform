import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { FreezeGuard } from "./freeze.js";
import { blockers, orderDriving, orderWaiting, type Blocker, type MergeOrder, type MergeOrderRule, type MergeOrderRules, type OrderSelf, type OrderWait, type OrderWaits, type RunHolds } from "./merge-order.js";
import { pinnedPaths } from "./pr-changed-paths.js";
import { VERSION_PACKAGES_BRANCH } from "./release.js";

interface RunLookup extends RunHolds {
  byPr(repo: RepoSlug, pr: number): { runId: string } | undefined;
}

interface MergeOrderGuardDeps {
  order: () => MergeOrder;
  registrations: () => RunLookup;
  rules: MergeOrderRules;
  now?: () => number;
  waits?: OrderWaits;
}

const SHOWN_PATHS = 3;
const CACHED_HEADS = 256;

function reasonOf({ reservation, shared }: Blocker): string {
  const more = shared.length > SHOWN_PATHS ? ` and ${shared.length - SHOWN_PATHS} more` : "";
  const what = shared.length === 0 ? "this PR's changed paths are unread" : `${shared.slice(0, SHOWN_PATHS).join(", ")}${more}`;
  return `merge order: waiting behind #${reservation.pr} (${what})`;
}

/** A failed read keeps the reservation blocking; its TTL still ends it. */
export async function stillOpen(port: GitHubPort, repo: RepoSlug, pr: number): Promise<boolean> {
  const read = await port.getPr(repo, pr).catch(() => undefined);
  return read === undefined || (read.state === "open" && !read.merged);
}

/** A PR's changed paths, read once per head and only when the read is whole; an unread list is read again next time. */
function pinnedPerHead(): (port: GitHubPort, repo: RepoSlug, pr: number, head: string | undefined) => Promise<Pick<OrderSelf, "paths" | "unread">> {
  const pinned = new Map<string, readonly string[]>();
  return async (port, repo, pr, head) => {
    const key = `${repo.toLowerCase()}#${pr}@${head}`;
    const cached = pinned.get(key);
    if (cached !== undefined) return { paths: cached };
    if (head === undefined) return { paths: [], unread: true };
    const read = await pinnedPaths(port, { repo, pr, head }, head);
    if (read.unread !== undefined) return { paths: [], unread: true };
    if (pinned.size >= CACHED_HEADS) pinned.clear();
    pinned.set(key, read.paths);
    return { paths: read.paths };
  };
}

interface GuardTarget {
  repo: RepoSlug;
  runId: string;
  pr: number;
}

/**
 * Why `repo#pr` waits behind an earlier conflicted PR that reserved paths it also changes. It reads nothing when the
 * repo's rule is off or no reservation in the repo is live, and it never orders a release PR, a stacked PR or a PR with
 * no Shepherd run. A PR's paths are read once per head; a list that cannot be read overlaps every reservation. A
 * reservation whose run a person holds, or that still waits for its own turn, orders nothing. Each new wait is logged as `order-wait`.
 * TP-4569: a run whose order wait hit the merging stall limit is not held behind a holder whose resolved head is only
 * in review, which on 10-29 kept a chain of resolved heads in `merging` through an 87 min review round.
 */
export function mergeOrderGuard(deps: MergeOrderGuardDeps): FreezeGuard {
  const now = deps.now ?? Date.now;
  const pathsAt = pinnedPerHead();
  const waits: OrderWaits = deps.waits ?? new Map();
  const blockerOf = async (port: GitHubPort, { repo, runId, pr }: GuardTarget, rule: MergeOrderRule, baseRef: string, head: string | undefined): Promise<Blocker | undefined> => {
    const order = deps.order();
    const driving = orderDriving(order, deps.registrations());
    const waiting = orderWaiting(order);
    const reservations = order.list(repo);
    if (blockers({ repo, runId, paths: [], unread: true }, reservations, rule, now(), driving, waiting).length === 0 || baseRef !== (await port.defaultBranch(repo))) return undefined;
    const waitedOut = order.waitedOut(runId);
    for (const blocker of blockers({ repo, runId, ...(await pathsAt(port, repo, pr, head)) }, reservations, rule, now(), driving, waiting)) {
      if (waitedOut && order.inResolvedReview(blocker.reservation)) continue;
      if (await stillOpen(port, repo, blocker.reservation.pr)) return blocker;
    }
    return undefined;
  };
  return {
    async reason(port, repo, pr, baseRef, head, branch) {
      const rule = deps.rules(repo);
      if (!rule?.enabled || branch === VERSION_PACKAGES_BRANCH) return undefined;
      const runId = deps.registrations().byPr(repo, pr)?.runId;
      if (runId === undefined) return undefined;
      const blocker = await blockerOf(port, { repo, runId, pr }, rule, baseRef, head);
      const wait = blocker && { repo: repo.toLowerCase(), pr, behind: blocker.reservation.pr, reason: reasonOf(blocker) };
      recordWait(waits, runId, wait, (noted) => deps.order().noteWait(runId, noted, new Date(now()).toISOString(), head));
      return wait?.reason;
    },
  };
}

/** A poll that reads the wait it read last logs nothing, so the timeline gains one entry per wait, not one per poll. */
function recordWait(waits: OrderWaits, runId: string, wait: OrderWait | undefined, log: (wait: OrderWait) => void): void {
  if (wait === undefined) {
    waits.delete(runId);
    return;
  }
  const last = waits.get(runId);
  if (last?.behind !== wait.behind || last.reason !== wait.reason) log(wait);
  waits.set(runId, wait);
}
