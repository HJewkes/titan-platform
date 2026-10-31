# @titan-design/fix-proof

## 0.9.0

### Minor Changes

- 7492819: - **Count work in timing tests instead of reading a clock (TP-4262).** Glob growth tests compared thread CPU ratios, which read up to 415 on a loaded hosted runner and turned main red. fix-proof's `LinearRegExp` now counts its NFA steps (`linearRegExpSteps`), and test-kit's `linearWork` compares those counts across a size ladder. It replaces the timed `linearGrowth`, which is removed. A matcher that falls back to a backtracking RegExp counts nothing and fails at size 1. test-kit also adds `countCalls` and `callMeter`, which count calls to chosen methods and stop at a cap. fix-proof's brace and glob rows and code-graph's reach and link rows use them in place of millisecond limits.
  - **Refuse new clock limits in tests.** eslint-plugin adds `no-test-clock-budget`. It reports a test that compares a clock reading, or a ratio of readings, with a limit outside a bench gate. The repo enables it with a shrink-only baseline that TP-4264 empties.
- 56d107b: Add head mode for generated mutants: `execHeadMutants` runs `HeadMutation`s (a `Mutation` with no `kills`) against head in a detached worktree, one owning-package suite per mutant with M + P rebuilds, and `classifyHeadRun` reads each run as `survived`, `caught`, `caught-error`, `load-error` or `timeout`. Mutations left when the budget runs out are listed in `unrun`. `checkMutation` now accepts a `HeadMutation`.
- 7a34209: The remaining RegExp glob compilers match in time linear in the path (TP-4223). fix-proof exports `LinearRegExp`, also from `@titan-design/fix-proof/linear-regexp`: a RegExp whose `test` simulates its source as an NFA, so a glob such as `d/` and twenty `*`, or `**/` repeated twelve times, can no longer hang a match. review-panel's `matchesGlob`, autoresearch's bounds globs, code-graph's `patternToRegex` and `.gitattributes` patterns, and tool-guard's merge-lint `globToRegExp`, guarded path patterns and glob command words now build one. Each still returns a RegExp and matches what it did, except that a glob too large for V8 to compile, which used to throw at its first test, now matches as written. test-kit exports `linearGrowth`, a growth-ratio ladder that fails a polynomial matcher on a small input before trying a large one, and `hostileGlobs`, the timing rows of tp#2491.
- 36dc03f: Add `headRuns` to `execSide`: the head side installs and builds once, then runs vitest 1 to 5 times and writes `head.report`, `head-2.report` and so on. A count outside that range writes error markers. Export `classifyDecoded` and `reportNames`.
- 32637bd: `proofStanding(read, head)` in fix-proof is the one reading of a fix-proof read at a head: `proved`, `no-repro` (with `proceeds` for a test-only or non-source NO_REPRO the caller lets through), `unverified`, `unproven` or `none`. `endsReview` and `needsTestsSeat` answer the two questions callers ask of it, and `FixProofUnverified` moves here. Shepherd's gate and waiver and review-panel's `fixProofNeedsTests` now derive from it instead of parsing the line each in their own way; no behavior changes, and `unproven` still lets the review run while making the tests seat blocking. review-panel re-exports `FixProofUnverified` unchanged. review-workflow's `ProofRead` is now fix-proof's `ProofReadInput` (TP-3923).
- d2cce6c: Give the fix-proof result line a `refused` verdict for a PR whose base is not the default branch (TP-4259). A refused line names the PR's `base` and the `defaultBranch` in fields of their own, with no count and no test, so no reader parses a message to find a refusal. Every judged line may also carry the `base` it judged; `fix-proof judge` takes it as `--base-ref`, and `fix-proof-run.sh` passes it from the workflow's `BASE_REF`. A reader that predates either field rejects the line, so it fails closed.

  The review panel counts a refused line as a bad fix-proof, as it did the error line that carried the refusal before.

  Shepherd's fix-proof read binds a run to the PR only when GitHub lists it on the PR's base and its line, if it names a base, names that same base. A run GitHub lists on main after a retarget, whose line judged the stacked parent, no longer counts as a second run on main. A job log that cannot be read is read again on the next poll and is an error at the deadline. A run's distrust is settled before its verdict is read. A refused line's standing is `refused`, and the MERGE evidence records the base the line judged as `proofBase`.

### Patch Changes

- 9c70c14: Keep a missing browser from reading as a vacuous proof. A base file that failed with every test skipped, as when a `beforeAll` hook throws, now classifies as an `error` verdict with file state `hook-error` instead of `not-run`. The sandboxed base run also forwards the runner's `PLAYWRIGHT_BROWSERS_PATH` when it is set; staging a browser the sandbox user can read is not part of this change.
- 708e154: Leave a self-contained carried test out of `mutants.uncovered` (TP-4075). A changed test is exempt when it matches the `carry` globs and its runtime imports reach only carried files, vitest and builtins that cannot start a process, a worker or evaluated source. Imports are followed through every carried file they reach. No mutation may target a carried file, so a test-only PR touching such a test could otherwise never reach `killed`. A changed test still needs a spec if it loads non-carried source (directly or through a carried helper), another package, or `child_process`, `worker_threads` or `vm`, or if it runs code outside the import graph. So does any test outside the carry paths. The rule assumes a carried test reads files only to judge tests or carried files.
- 6a2471a: Leave tests head skips or marks todo out of `classifyReports`, so a test-only diff whose files hold `it.skipIf` or `it.todo` can be proved by its mutants (TP-4079). A skip inside a failed file, or of a test base passed, still counts as `not-run`. The result line's shape is unchanged.
- 0848c31: `compileGlobs` matches in time linear in the path instead of compiling a backtracking RegExp, so a short glob such as `d/` and twenty `*`, `**/` repeated, or `*a` repeated can no longer hang a fix-proof plan or an egress-scan `.egress-allow` check. Match results are unchanged.
- 136b507: The judge now matches a source diff's mutation spec kills against the head report. A kill that names no test at head makes the verdict `error`, with a mutants error naming each stale kill. Before this, such a spec landed without being read.
- f5d92f3: A mutation spec kill that names no test in a baseline that loaded is now an `error` verdict naming the spec, mutation
  and kill, with the full title when exactly one test ends with the bare one. It was a `baseline` outcome, which read as
  a test that failed before the mutant rather than a kill that could never match.
- bea67f1: `LinearRegExp` allocates its NFA buffers once per compiled source instead of once per `test`, so a glob tested hundreds of thousands of times no longer spends most of its time allocating typed arrays.
- 661a027: A diff that changes only a mutation spec now plans the spec's sibling test (TP-4039). `planFixProof` takes an optional `headFiles` list, the paths at head beside the diff's specs; a spec whose one sibling test is listed there and not deleted adds that test to `tests`, so the spec's mutants are judged instead of the diff reading as `no-tests`. The runner and judge list each spec's directory at head and pass it in. Without `headFiles` the plan is unchanged.
- 4080191: Typed-lint burn-down: replace type assertions in config, plan, classify, report and result-line parsing with narrowing. No verdict changes.
- 2451aa9: The mutants side now parses and pairs a diff's `*.mutations.json` specs even when the diff changes source, and runs each mutation through `checkMutation` against head there (its new optional `at` names that commit in the error). Any refused spec, or on a source diff any failure reading one, also writes `mutants.refused`, which fails the fix-proof-mutants job. Before, a source diff skipped its specs unread, so over-cap specs landed. tool-guard: one sidecar mutation name shortened to the 80-character cap; test material only.
- 719f05e: Skip the rebuild for a mutated file outside every workspace package, so mutants on root scripts no longer fail on a whole-repo build.

## 0.8.0

### Minor Changes

- 749bea7: A pull request that only adds or changes tests can now prove itself without an owner waiver (TP-3658). `@titan-design/fix-proof` exports `provedByMutants(result)`: true when a `vacuous` result's mutation check is `killed`, every changed test file has a spec of its own in the diff, no test was deleted or renamed out of the tests, and every selected test ran and passed at head. The judge attaches mutants only to a diff `testOnlyReading` calls test-only, so one that deletes a test never carries them. The judge lists changed test files without a spec as `mutants.uncovered` and demotes `killed` to `not-killed` when any remain, so a spec beside an unchanged test cannot vouch for a test the PR changed. The fix-proof workflow gains a `fix-proof-mutants` job that runs `exec --side mutants` in the sandbox when the diff adds or changes a `*.mutations.json` spec, and the judge reads its report. Shepherd's fix-proof gate lets such a head go to review; a surviving mutation, a failing or unrun test, or a mutants error still ends the round as `NO_REPRO`, and the wake asks for kills. The tests reviewer's brief reads a proved head as proved rather than as a blocking vacuous proof. A run may now move into `--kind test-only`, under the existing diff check.

## 0.7.0

### Minor Changes

- 4d131dc: Add an optional `runtime` glob list to `.github/fix-proof.json` (TP-3056 a): matching paths stay carried but read as `source`. Add `testOnlyReading(plan)`, which refuses test-only with `source`, `deletes-tests` or `no-tests`.

## 0.6.0

### Minor Changes

- 6aa69f2: Add the mutation check's exec side (TP-2732 c1). `fix-proof exec --side mutants` (`execMutants`) builds the merge base, overlays the head's tests, runs a baseline, then applies each declared mutation alone, rebuilds the package that owns its file, reruns the spec's test file and restores it, writing one `mutants.report`. With `--sandbox-user`, every build and vitest call after the overlay runs in the sandbox. `fix-proof judge --mutants-report <file>` reads that report into the result line's `mutants` field.

## 0.5.0

### Minor Changes

- 59131da: Split the runner into `execSide`, `judge` and a report transport (`encodeReport`, `encodeError`, `decodeReport`). Each exec side writes capped, gzip and base64 encoded reports with repo-relative names; `judge` recomputes the plan from git, decodes the reports under an 8 MB inflate cap and prints the one fix-proof/v1 line, spawning nothing but git. The base side now installs and builds before any head file is overlaid, and always runs its tests twice. `run` composes the two sides and the judge in-process.
- 62adbb2: Add `fix-proof exec --side base|head --out <dir>` and `fix-proof judge --base-report <file> --head-report <file> [--base-rerun-report <file>]` subcommands, and a `dist/judge.js` entry that can only judge. Every failure, including bad arguments, is still an `error` result line with exit 0.
- 15b5395: `fix-proof exec --sandbox-user <name>` (and `ExecSideOptions.sandboxUser`) runs each base-side vitest call through `sudo -n` in a fresh PID namespace as that user, with `no_new_privs` and an empty capability bounding set, so no `setsid` child of a head test outlives the run to rewrite the base reports. The vitest output is read only as a regular non-symlink file, and a sandbox that cannot be set up writes error markers instead of running unsandboxed. The head side ignores the flag.
- 7d93a92: Add mutation specs and test-only diffs (TP-2732 a): `parseMutationSpec`, `checkMutation`, `MUTATION_SPEC_GLOB`, `CHANGESET_GLOB`, `FIX_PROOF_HARNESS`/`isHarnessPath`, and `mutations` and `source` buckets on `FixProofPlan` with `testOnlyOf(plan)`.
- edcb589: Add the mutation check's verdict (TP-2732 b). `classifyMutants` marks each mutation `killed` only when the tests failing under it, each with an assertion failure, are exactly its `kills`. `encodeMutantsReport`/`decodeMutantsReport` carry the mutants side's report to the judge. The `fix-proof/v1` line gains an optional `mutants` field, which the judge attaches only to a diff of test material alone that adds a spec.
- b6072b5: `exec` and `run` install, build and test a tree with only a `package-lock.json` through npm
  (`npm ci --no-audit --no-fund`, `npm run build --if-present`, `npm exec --no -- vitest run`), so
  npm repos such as agent-chat and relay can be proven. pnpm trees are unchanged, and
  `.github/fix-proof.json` `build` and `command` still override the defaults.

### Patch Changes

- 336aaf2: Harden fix-proof against a PR head that plants `refs/replace` objects or pathspec magic in the shared checkout: every git call now passes `--no-replace-objects --literal-pathspecs`. A selected test path starting with `-` is an error verdict instead of a vitest flag, and `execSide` resolves even when its out dir cannot be written.
- 7499737: Every fix-proof git call now also passes `-c core.fsmonitor=false -c core.hooksPath=/dev/null`, and the plan's `git diff` passes `--no-ext-diff --no-textconv`, so an fsmonitor, hook, external diff or textconv program that PR code writes into the shared `.git` never runs.
- 069c3b2: `run()` gives the base side, the head side and the judge their own bare snapshot of the two commits, fetched before either side runs, and reads the base reports before the head side starts, so head code cannot plant config, smudge filters or objects in the caller's repo or the judge's inputs (TP-2430 b).
- 462e693: Correct the `SANDBOX_FLAG` doc comment: `fix-proof-run.sh` finds the flag in any `dist/*.js` chunk, not only `dist/bin.js` (TP-2522).

## 0.4.0

### Minor Changes

- 8bc0f25: Add the `fix-proof run` bin and `run()`: overlay the head's tests and carried files on a merge-base worktree, build, run vitest JSON on base (again once when vacuous) and head under a budget, and print one `fix-proof/v1` line, always exiting 0.

### Patch Changes

- ef240c0: `formatResultLine` drops non-reproducing tests before reproducing ones when trimming a result line to 4 KB.

## 0.3.0

### Minor Changes

- 63c2836: `classifyReports` now gives `error` instead of `reproduced` when any selected file is missing from the head report or fails to load there, matching the documented rule that ambiguous input never classifies as `reproduced`.

## 0.2.0

### Minor Changes

- f7161c0: `.egress-allow` globs now compile through fix-proof's shared glob compiler, so `docs/{a,b}.md` expands braces instead of matching nothing. The literal-segment guard checks every brace alternative. `AllowEntry.pattern` (a `RegExp`) is replaced by `AllowEntry.matches`. fix-proof exports `expandBraces`.

### Patch Changes

- f7161c0: `expandBraces` rejects a glob longer than 1024 characters or with more than 32 brace groups before expanding, so single-choice brace chains cannot exhaust memory. egress-scan turns any glob compile failure into an `AllowFileError`, and the root `prepare` builds fix-proof before egress-scan.
- f7161c0: `expandBraces` enforces its 256-alternative cap while expanding, so a glob like `{4096 alternatives}{256 alternatives}` is rejected after 257 strings instead of building the whole product first.

## 0.1.0

### Minor Changes

- 1670037: Add `@titan-design/fix-proof`, the pure core of the fix-proof gate: `planFixProof` (name-status diff and base config to tests, carried files, deleted tests and overlay removals; renames keep their identity), `classifyReports` (base and head vitest JSON to per-test classes and a `reproduced`, `unproven`, `vacuous`, `no-tests` or `error` verdict, matching report files exactly) and `formatResultLine`/`parseResultLine` (a strict `fix-proof/v1` line of at most 4 KB).
