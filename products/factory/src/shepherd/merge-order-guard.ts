import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { FreezeGuard } from "./freeze.js";
import { blockers, type Blocker, type MergeOrder, type MergeOrderRules, type OrderSelf } from "./merge-order.js";
import { pinnedPaths } from "./pr-changed-paths.js";
import { VERSION_PACKAGES_BRANCH } from "./release.js";

interface RunLookup {
  byPr(repo: RepoSlug, pr: number): { runId: string } | undefined;
}

interface MergeOrderGuardDeps {
  order: () => MergeOrder;
  registrations: () => RunLookup;
  rules: MergeOrderRules;
  now?: () => number;
}

const SHOWN_PATHS = 3;
const CACHED_HEADS = 256;

function reasonOf({ reservation, shared }: Blocker): string {
  const more = shared.length > SHOWN_PATHS ? ` and ${shared.length - SHOWN_PATHS} more` : "";
  const what = shared.length === 0 ? "this PR's changed paths are unread" : `${shared.slice(0, SHOWN_PATHS).join(", ")}${more}`;
  return `merge order: waiting behind #${reservation.pr} (${what})`;
}

/** A failed read keeps the reservation blocking; its TTL still ends it. */
async function stillOpen(port: GitHubPort, repo: RepoSlug, pr: number): Promise<boolean> {
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

/**
 * Why `repo#pr` waits behind an earlier conflicted PR that reserved paths it also changes. It reads nothing when the
 * repo's rule is off or no reservation in the repo is live, and it never orders a release PR, a stacked PR or a PR with
 * no Shepherd run. A PR's paths are read once per head; a list that cannot be read overlaps every reservation.
 */
export function mergeOrderGuard(deps: MergeOrderGuardDeps): FreezeGuard {
  const now = deps.now ?? Date.now;
  const pathsAt = pinnedPerHead();
  return {
    async reason(port, repo, pr, baseRef, head, branch) {
      const rule = deps.rules(repo);
      if (!rule?.enabled || branch === VERSION_PACKAGES_BRANCH) return undefined;
      const order = deps.order();
      const runId = deps.registrations().byPr(repo, pr)?.runId;
      if (runId === undefined) return undefined;
      const driving = (id: string): boolean => order.isDriving(id);
      const reservations = order.list(repo);
      if (blockers({ repo, runId, paths: [], unread: true }, reservations, rule, now(), driving).length === 0 || baseRef !== (await port.defaultBranch(repo))) return undefined;
      const self = { repo, runId, ...(await pathsAt(port, repo, pr, head)) };
      for (const blocker of blockers(self, reservations, rule, now(), driving)) {
        if (await stillOpen(port, repo, blocker.reservation.pr)) return reasonOf(blocker);
      }
      return undefined;
    },
  };
}
