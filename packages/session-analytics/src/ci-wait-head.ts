const GH_ALTERNATION = "gh pr checks|gh run";
const CI_WAIT_ALTERNATION = `ci-wait|${GH_ALTERNATION}`;

/**
 * The one rule for what a CI wait looks like: the `ci-wait` helper or the `gh pr checks` / `gh run`
 * family. A command head, as session-read reduces a call to it, is tested from its start.
 */
export const CI_WAIT_HEAD = new RegExp(`^(?:${CI_WAIT_ALTERNATION})\\b`);

/**
 * The same rule for a whole command line, where the head may follow `cd`, `;` or `&&`. The helper
 * counts only when invoked, so `cat ci-wait-head.ts` or `grep ci-wait x` is not a CI wait.
 */
export const CI_WAIT_IN_COMMAND = new RegExp(
  `(?:^|[;&|(\\n])\\s*(?:\\S*/)?ci-wait(?=\\s|$)|\\b(?:${GH_ALTERNATION})\\b`,
);
