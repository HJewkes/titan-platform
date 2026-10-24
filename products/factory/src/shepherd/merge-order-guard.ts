import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { FreezeGuard } from "./freeze.js";
import { blockers, type Blocker, type MergeOrder, type MergeOrderRule, type MergeOrderRules, type OrderSelf } from "./merge-order.js";
import { pinnedPaths } from "./pr-changed-paths.js";
import { VERSION_PACKAGES_BRANCH } from "./release.js";

interface RunLookup {
  byPr(repo: RepoSlug, pr: number): { runId: string } | undefined;
}

/** The merge-order wait a run's merge step read last; kept in serve's memory, for `shepherd status` and `shepherd order`. */
export interface OrderWait {
  repo: string;
  pr: number;
  behind: number;
  reason: string;
}

/** Keyed by run id; a merge step that reads no blocker drops its run's entry. */
export type OrderWaits = Map<string, OrderWait>;

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
 * no Shepherd run. A PR's paths are read once per head; a list that cannot be read overlaps every reservation.
 */
export function mergeOrderGuard(deps: MergeOrderGuardDeps): FreezeGuard {
  const now = deps.now ?? Date.now;
  const pathsAt = pinnedPerHead();
  const blockerOf = async (port: GitHubPort, { repo, runId, pr }: GuardTarget, rule: MergeOrderRule, baseRef: string, head: string | undefined): Promise<Blocker | undefined> => {
    const order = deps.order();
    const driving = (id: string): boolean => order.isDriving(id);
    const reservations = order.list(repo);
    if (blockers({ repo, runId, paths: [], unread: true }, reservations, rule, now(), driving).length === 0 || baseRef !== (await port.defaultBranch(repo))) return undefined;
    for (const blocker of blockers({ repo, runId, ...(await pathsAt(port, repo, pr, head)) }, reservations, rule, now(), driving)) {
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
      const reason = blocker && reasonOf(blocker);
      if (blocker && reason) deps.waits?.set(runId, { repo: repo.toLowerCase(), pr, behind: blocker.reservation.pr, reason });
      else deps.waits?.delete(runId);
      return reason;
    },
  };
}
