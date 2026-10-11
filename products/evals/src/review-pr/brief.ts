import { reviewerBrief, type ReviewerBriefInput } from "@titan-design/review-panel";

/** The line the live brief puts directly above its checkout commands; the block ends at the next blank line. */
const CHECKOUT_LEAD = "Read the code at exactly that commit, not at a branch tip:";

/** What the trial reads in place of a live checkout: a bundle `materializeBundle` wrote. */
export function bundleLines(bundleDir: string): string[] {
  const dir = bundleDir.replace(/\/+$/, "");
  return [
    `  The head tree is extracted at "${dir}/head"; it has no .git directory.`,
    `  The diff from base to head is the file "${dir}/diff.patch".`,
    `If you need the base for comparison, it is extracted at "${dir}/base". Read only these paths for this pull request's code; there is no network and no gh.`,
  ];
}

/**
 * The live reviewer brief with only its checkout block swapped for bundle paths: the live block runs `gh pr diff`,
 * which returns today's PR and would leak the later fix. Every other line stays byte-identical to `reviewerBrief`.
 */
export function reviewPrBrief(input: ReviewerBriefInput, bundleDir: string): string {
  const lines = reviewerBrief(input).split("\n");
  const start = lines.indexOf(CHECKOUT_LEAD) + 1;
  const end = start > 0 ? lines.indexOf("", start) : -1;
  if (end < 0) throw new Error("reviewerBrief no longer has the checkout block the trial brief replaces");
  return [...lines.slice(0, start), ...bundleLines(bundleDir), ...lines.slice(end)].join("\n");
}
