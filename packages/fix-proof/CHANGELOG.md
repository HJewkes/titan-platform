# @titan-design/fix-proof

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
