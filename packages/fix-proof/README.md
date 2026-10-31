# @titan-design/fix-proof

Decides whether a fix pull request's new tests prove the fix: they must fail on the merge
base with the non-test changes removed and pass at head. Pure functions plan and classify;
the `fix-proof` bin does the git and vitest work.

- `planFixProof({ nameStatus, baseConfig, headConfig, headFiles })`: tests to run, carried support files,
  deleted tests and overlay removals, with globs from the base config only. It also lists
  mutation specs (`mutations`) and every non-test path (`source`). A spec whose one sibling test
  is in `headFiles` (paths at head beside the specs) and not deleted plans that test, so a
  spec-only diff still has a test for its mutants; `testOnlyOf(plan)` is true
  when `source` is empty. Paths matching the config's `runtime` globs (fixtures a package
  publishes or production code reads) stay carried but also count as `source`.
  `testOnlyReading(plan)` refuses test-only with a reason: `source`, then `deletes-tests` for any
  deleted test (a test renamed to a non-test path included), then `no-tests` for a diff that adds
  or changes no test, such as a changeset- or fixture-only diff.
- `parseMutationSpec(text)` and `checkMutation(mutation, baseText, config, at?)`: a strict
  `*.mutations.json` spec of 1 to 5 named find/replace mutations with the tests each must fail,
  and the merge-base check that each `find` occurs exactly once in a file that is not test material.
- `classifyReports({ selected, base, head })`: per-test `reproduces`, `passes-on-base`,
  `new-api`, `fails-on-head` or `not-run`, and a verdict of `reproduced`, `unproven`,
  `vacuous`, `no-tests` or `error`. A test head skips or marks todo in a file that did not
  fail is left out, unless base passed it.
- `toResult`, `formatResultLine` and `parseResultLine`: one `fix-proof/v1 <json>` line of at
  most 4 KB, parsed strictly.
- `classifyMutants(specs, decoded)`: each declared mutation is `killed` only when its rebuild
  succeeded, its `kills` tests passed once in the baseline, and the tests failing under it,
  each an assertion failure, are exactly its `kills`. Otherwise it is `overkill`, `survived`,
  `unbuilt`, `load-error`, `baseline` or `error`. A kill must be the test's full name (describe
  titles, then the test title); one that names no test in a baseline that loaded makes the whole
  verdict `error`, naming the spec, mutation and kill. `encodeMutantsReport` and
  `decodeMutantsReport` carry the mutants side's baseline and per-mutation runs to the judge.
- `provedByMutants(result)`: true when a `vacuous` result's `mutants` verdict is `killed`, no
  changed test file lacks a spec of its own (`mutants.uncovered` present and empty; a changed
  carried test whose runtime imports, followed through carried files, reach only carried files,
  vitest and builtins that cannot start a process, worker or evaluated source needs none, since
  no mutation may target a carried file), no test was
  deleted or renamed out of the tests, and every selected test ran and passed at head: the proof a test-only diff can give.
- `proofStanding(read, head)`: the one reading of a fix-proof read (`ProofReadInput`: a judged
  line, trusted or `untrusted`, a workflow-only diff's `workflow-ci` read, an `error` read, or a
  `skipped` or `missing` one) at a head. It is `proved`, `no-repro` (with `proceeds` when the caller
  lets a test-only or non-source NO_REPRO through), `unverified` (a `FixProofUnverified` reason, and
  the read's error text as `detail`), `unproven` or `none`. `endsReview(standing)` and
  `needsTestsSeat(standing)` answer the two questions callers ask of it; `unproven` needs the tests
  seat but does not end the review.

- `fix-proof exec --side base|head --out <dir> --base <mergeBase> --head <sha>` builds and tests
  one side and writes encoded reports (`base.report` and `base-rerun.report`, or `head.report`)
  to `<dir>`. The base side installs and builds before any head file is overlaid. The install,
  build and test defaults follow the tree's lockfile: pnpm for `pnpm-lock.yaml`, npm for a lone
  `package-lock.json`. With
  `--sandbox-user <name>`, each base-side vitest run goes through `sudo -n` into a fresh PID
  namespace as that user, with `no_new_privs` and no capabilities, so no process a head test
  starts outlives the run or writes the runner's files. A sandbox that cannot be set up writes
  error markers; vitest never falls back to an unsandboxed run. The head side ignores the flag.
- `fix-proof exec --side mutants --out <dir> ...` writes one `mutants.report` for a diff of
  test material alone that adds a `*.mutations.json` spec. It builds the merge base, overlays the
  head's tests and carried files, runs the specs' test files once as a baseline, then applies each
  mutation alone to the merge-base text of its file, rebuilds the package that owns it, reruns the
  spec's test file, and restores and rebuilds again. With `--sandbox-user`, every build and vitest
  call after the overlay runs in the sandbox. No spec, or source in the diff, writes a skipped
  marker, but a source diff's specs are still parsed, paired and run through `checkMutation`
  against head. A spec refused either way, or on a source diff any failure reading one, also
  writes its reason to `mutants.refused`, and `scripts/fix-proof-run.sh` fails the mutants job
  on it, since the judge never reads a source diff's specs. `execMutants()` is the
  same as a function.
- `fix-proof judge --base-report <file> --head-report <file> [--base-rerun-report <file>]
  [--mutants-report <file>] --base <mergeBase> --head <sha>` derives the plan from git, decodes
  the reports under a byte cap and prints one result line, with `mutants` read from
  `--mutants-report`. It spawns nothing but git. `dist/judge.js` is the same command on its own;
  it cannot run `exec` or `run`.
- `fix-proof run --base <mergeBase> --head <sha>` runs both sides and the judge in one process,
  for local use. Each side and the judge read their own bare snapshot of the two commits, fetched
  before either side runs, and the base reports are read before the head side starts, so head code
  cannot plant config, filters or objects in the caller's repo or the judge's. The head side still
  runs as the caller's uid and could reach the judge's snapshot on purpose. `execSide()`,
  `judge()` and `run()` are the same as functions. `execSide({ side: "head", headRuns: 3 })` installs and
  builds once, then runs vitest up to 5 times and writes `head.report`, `head-2.report`, ...;
  `classifyDecoded(plan, reports)` classifies one decoded report set without the judge's result line.

Every subcommand takes `[--repo <dir>] [--budget-ms <n>]`, always exits 0 and turns any
failure into an `error` result line. In CI each side is its own job and the judge, the only job
Shepherd reads, runs merge-base code alone. A head test that detects the base and fails on purpose
can still fake `reproduces`; that is test content, left to review.

## Head mode (generated mutants)

`execHeadMutants({ repo, head, mutations, budgetMs?, sandboxUser?, exec? })` runs generated
mutations (`HeadMutation`, a `Mutation` with no `kills`) against head, for callers such as
code-graph's body-delete audit. It adds a detached worktree at head, installs and builds once,
groups the mutations by owning package, and runs one baseline over the union of those
packages' test files (the head config's `tests` globs under each package). Each mutation is
checked with `checkMutation(..., "head")`, written, rebuilt and run against its own package's
suite, then its text is restored; each package is rebuilt once more after its last mutation,
so M mutations over P packages cost M + P rebuilds. `classifyHeadRun` reads each run against
the tests that passed in the baseline: `survived`, `caught` (an AssertionError), `caught-error`
(failures, none an AssertionError), `load-error` or `timeout`. Mutations left when the budget
(default 13 minutes) runs out are listed in `unrun`, never classified. The call never throws
and never writes the caller's checkout. It computes no score, and there is no CLI subcommand.

Tier 0 of the titan-platform DAG, with no dependencies. Tracked by TP-541 (TP-538 S1) and TP-542 (S2).
Full reference: `site/reference/fix-proof.md`.
