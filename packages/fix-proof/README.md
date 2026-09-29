# @titan-design/fix-proof

Decides whether a fix pull request's new tests prove the fix: they must fail on the merge
base with the non-test changes removed and pass at head. Pure functions only; a runner does
the git and vitest work and hands the text in.

- `planFixProof({ nameStatus, baseConfig, headConfig })`: tests to run, carried support files,
  deleted tests and overlay removals, with globs from the base config only.
- `classifyReports({ selected, base, head })`: per-test `reproduces`, `passes-on-base`,
  `new-api`, `fails-on-head` or `not-run`, and a verdict of `reproduced`, `unproven`,
  `vacuous`, `no-tests` or `error`.
- `toResult`, `formatResultLine` and `parseResultLine`: one `fix-proof/v1 <json>` line of at
  most 4 KB, parsed strictly.

Tier 0 of the titan-platform DAG, with no dependencies. Tracked by TP-541 (TP-538 S1).
Full reference: `site/reference/fix-proof.md`.
