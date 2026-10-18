# @titan-design/fix-proof

Decides whether a fix pull request's new tests prove the fix: they must fail on the merge
base with the non-test changes removed and pass at head. Pure functions plan and classify;
the `fix-proof` bin does the git and vitest work.

- `planFixProof({ nameStatus, baseConfig, headConfig })`: tests to run, carried support files,
  deleted tests and overlay removals, with globs from the base config only. It also lists
  mutation specs (`mutations`) and every non-test path (`source`); `testOnlyOf(plan)` is true
  when `source` is empty. Paths matching the config's `runtime` globs (fixtures a package
  publishes or production code reads) stay carried but also count as `source`.
  `testOnlyReading(plan)` refuses test-only with a reason: `source`, then `deletes-tests` for any
  deleted test (a test renamed to a non-test path included), then `no-tests` for a diff that adds
  or changes no test, such as a changeset- or fixture-only diff.
- `parseMutationSpec(text)` and `checkMutation(mutation, baseText, config)`: a strict
  `*.mutations.json` spec of 1 to 5 named find/replace mutations with the tests each must fail,
  and the merge-base check that each `find` occurs exactly once in a file that is not test material.
- `classifyReports({ selected, base, head })`: per-test `reproduces`, `passes-on-base`,
  `new-api`, `fails-on-head` or `not-run`, and a verdict of `reproduced`, `unproven`,
  `vacuous`, `no-tests` or `error`.
- `toResult`, `formatResultLine` and `parseResultLine`: one `fix-proof/v1 <json>` line of at
  most 4 KB, parsed strictly.
- `classifyMutants(specs, decoded)`: each declared mutation is `killed` only when its rebuild
  succeeded, its `kills` tests passed once in the baseline, and the tests failing under it,
  each an assertion failure, are exactly its `kills`. Otherwise it is `overkill`, `survived`,
  `unbuilt`, `load-error`, `baseline` or `error`. `encodeMutantsReport` and
  `decodeMutantsReport` carry the mutants side's baseline and per-mutation runs to the judge.

- `fix-proof exec --side base|head --out <dir> --base <mergeBase> --head <sha>` builds and tests
  one side and writes encoded reports (`base.report` and `base-rerun.report`, or `head.report`)
  to `<dir>`. The base side installs and builds before any head file is overlaid. The install,
  build and test defaults follow the tree's lockfile: pnpm for `pnpm-lock.yaml`, npm for a lone
  `package-lock.json`. With
  `--sandbox-user <name>`, each base-side vitest run goes through `sudo -n` into a fresh PID
  namespace as that user, with `no_new_privs` and no capabilities, so no process a head test
  starts outlives the run or writes the runner's files. A sandbox that cannot be set up writes
  error markers; vitest never falls back to an unsandboxed run. The head side ignores the flag.
- `fix-proof judge --base-report <file> --head-report <file> [--base-rerun-report <file>] --base
  <mergeBase> --head <sha>` derives the plan from git, decodes the reports under a byte cap and
  prints one result line. It spawns nothing but git. `dist/judge.js` is the same command on its
  own; it cannot run `exec` or `run`.
- `fix-proof run --base <mergeBase> --head <sha>` runs both sides and the judge in one process,
  for local use. Each side and the judge read their own bare snapshot of the two commits, fetched
  before either side runs, and the base reports are read before the head side starts, so head code
  cannot plant config, filters or objects in the caller's repo or the judge's. The head side still
  runs as the caller's uid and could reach the judge's snapshot on purpose. `execSide()`,
  `judge()` and `run()` are the same as functions.

Every subcommand takes `[--repo <dir>] [--budget-ms <n>]`, always exits 0 and turns any
failure into an `error` result line. In CI each side is its own job and the judge, the only job
Shepherd reads, runs merge-base code alone. A head test that detects the base and fails on purpose
can still fake `reproduces`; that is test content, left to review.

Tier 0 of the titan-platform DAG, with no dependencies. Tracked by TP-541 (TP-538 S1) and TP-542 (S2).
Full reference: `site/reference/fix-proof.md`.
