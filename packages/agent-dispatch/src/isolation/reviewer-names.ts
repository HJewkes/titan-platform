/**
 * CC-916: a reviewer reads and runs checks, and its git writes (a checkout of the PR head, a
 * stash, a pull) must never land in a repo's primary checkout, where they block deploys.
 *
 * Reviewer-ness is read from names rather than a profile field, because a reviewer profile is
 * operator-configured (`rv-readonly`) and a profile written before this existed has no flag to
 * carry. Tokens are matched whole so `reviewer-lite` counts and `previewer` does not.
 */
const REVIEWER_TOKENS = new Set(["reviewer", "rv"]);

const tokensOf = (name: string): string[] => name.toLowerCase().split(/[^a-z0-9]+/);

export function isReviewerSpawn(profileName: string, agentName: string): boolean {
  return (
    tokensOf(profileName).some((t) => REVIEWER_TOKENS.has(t)) || tokensOf(agentName)[0] === "rv"
  );
}

/**
 * CC-1469: deliberately looser than `isReviewerSpawn`, because a tree name feeds only pool and
 * state counting. A whole `review` token counts, so an adversarial `seat-1-adv-review` is a
 * reviewer tree and `preview` is not; the spawn side leaves `review` out, since a reviewer spawn
 * is forced into a worktree and parked at report.
 */
const REVIEWER_TREE_TOKENS = new Set(["reviewer", "review"]);

/**
 * CC-1040: a tree on disk carries only its directory name, so the reviewer worktree pool is
 * decided from the agent name alone, the same way when allocating and when counting.
 */
export function isReviewerTreeName(name: string): boolean {
  const tokens = tokensOf(name);
  return tokens[0] === "rv" || tokens.some((t) => REVIEWER_TREE_TOKENS.has(t));
}
