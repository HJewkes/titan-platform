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

/** A trial has no CI run to cite, so the live rule's missing-check-is-blocking line would turn every verdict into FIX_FIRST. */
export const TRIAL_TEST_RULE = "This trial has no CI and no network: run no tests, builds, typecheck or lint, install nothing, and judge from the code and the diff alone.";

/**
 * The live reviewer brief, built with the trial's test rule, with only its checkout block swapped for bundle paths: the
 * live block runs `gh pr diff`, which returns today's PR and would leak the later fix. Every other line stays
 * byte-identical to `reviewerBrief` given the same rule.
 */
export function reviewPrBrief(input: ReviewerBriefInput, bundleDir: string): string {
  const lines = reviewerBrief({ ...input, testRule: TRIAL_TEST_RULE }).split("\n");
  const start = lines.indexOf(CHECKOUT_LEAD) + 1;
  const end = start > 0 ? lines.indexOf("", start) : -1;
  if (end < 0) throw new Error("reviewerBrief no longer has the checkout block the trial brief replaces");
  return [...lines.slice(0, start), ...bundleLines(bundleDir), ...lines.slice(end)].join("\n");
}
