# @titan-design/worktree

## 0.4.0

### Minor Changes

- 247171d: The git env pins no longer export the full protocol list, which outranked a caller's own `protocol.*.allow` denies (CC-1336). `pinGitProtocols` now returns `undefined` (leave GIT_ALLOW_PROTOCOL unset) for an unset value or the legacy `file:git:http:https:ssh`, and still intersects any other caller list with the safe list. `withPinnedGitProtocols`, `gitChildEnv` and `setupEnv` append `protocol.ext.allow=never` as the last `GIT_CONFIG_COUNT` pair, after `gitChildEnv`'s prefix stripping, keep caller pairs, and throw on a count git would die on.
- 9ad447f: Add a `ghTimeoutMs` allocator option (and a matching trailing `inspectForRelease` argument) that bounds each `gh pr view` a release makes. It defaults to the old fixed 3 seconds, exported as `DEFAULT_GH_TIMEOUT_MS`.
- d5e44a5: `inspectForRelease` and `sweepWorktrees` accept an `ignoredFiles` policy (`{ disposable: string[] }`) naming extra ignored paths that do not block release or make a tree hold work. Patterns support `*` and `**` and cover everything beneath a match. With no policy the behaviour is unchanged.

### Patch Changes

- ca8e8b7: Install the park default-proof test's git shim through a staged copy so a concurrent fork cannot hold it open for writing (ETXTBSY), which park read as a detached HEAD.
- 8b92ba0: - **Git fixtures in test-kit (TP-4446).** A new `@titan-design/test-kit/git` subpath holds the template repositories worktree's tests used: `seedRepo` and `seedRepoWithOrigin` build each seed once per test file and copy it per test, with auto-maintenance, gc and fsync off and an empty hooks directory. `withHistory` writes many commits with one `git fast-import` at pinned dates, `fixtureEnv` drops injected `GIT_CONFIG_*` entries and host config, and `gitIn` runs git in a directory under it. The subpath takes `vitest` as an optional peer dependency.
  - worktree's tests use the subpath; its private `git-fixture` and `test-env` copies are deleted. No runtime change.
- f3d3107: Narrow error and record values instead of asserting them, with no change in behaviour.
- 8031169: Install the typed-presentation test's git and gh shims through a staged copy so a concurrent fork cannot hold them open for writing (ETXTBSY), which release read as no merged-PR proof and so skipped its post-proof status check.

## 0.3.0

### Minor Changes

- a16ce17: Add optional host-defined allocation groups, name-aware budgets/error factories, strict requested origin-branch checkouts and branch-keeping release for parked allocations. Requested checkouts preserve fetched-default setup authority; an explicit skipSetup option supports caller-owned orchestration without running setup twice. Existing unconfigured allocation defaults remain unchanged.
- a16ce17: Add an opt-in fresh DEFAULT ancestry proof for parking an unpushed branch whose actual HEAD is already backed by that fetched tip. Preserve default refusal behavior and recheck files, branch and HEAD after asynchronous proof and caller lifecycle checks.
- a16ce17: Expose setup outcome reports while preserving the existing warnings-only helper, setup authority, execution and diagnostics.
- a16ce17: Add opt-in setup target data while preserving default allocation shapes and setup behavior.
- a16ce17: Allow synchronous presentation of already classified sweep holds-work entries from a frozen copy of the existing dirty/unmerged observation, preserving default details and safety classifications.

### Patch Changes

- a16ce17: Add an explicit lazy local commit backing reader for origin-head parking, with opaque selected correlation, complete commit validation and fresh safety rechecks. Preserve ordinary park defaults and keep provider policy in product adapters.
- a16ce17: Recheck file and unbacked-commit safety before ordinary reclaim, retaining Git-only proof, caller force distinction and the sweep lifecycle gate.
- a16ce17: Add an explicit actual-branch origin-head ancestry opt-in for parking, with typed branch metadata, fresh alternative-head proof and repeated file/HEAD guards while preserving default behavior.
- a16ce17: Add an explicit park-only ignored-file policy with readonly observations,
  validated synchronous protected subsets and presentation-only refusals. Keep
  default behavior unchanged and recheck opt-in file policy around asynchronous
  proof and lifecycle checks before nonforced removal.
- a16ce17: Export the existing strict default-branch fetch helper so consumers can delete their copy without adopting allocation's local-HEAD fallback.
- a16ce17: Restore transport-independent coverage of the shared fetch deadline without changing protocol policy or runtime behavior.
- a16ce17: Preserve the existing dispatcher CC410 guard by disabling repository checkout
  hooks for each worktree-add invocation, without persisting configuration or
  changing later git hooks. Keep timeout and late cleanup aware of the invocation
  prefix; retain child cleanup coverage with the existing filter-timeout fixture.
- a16ce17: Expose listWorktreesPorcelain for callers that need Git's unfiltered, untrimmed worktree listing, preserving the existing Git environment and failure behavior.
- a16ce17: Pin Playwright browser garbage collection off in the setup environment, preserving shared browser caches when setup runs outside permission profiles.
- a16ce17: Export the existing guarded setup filenames from the package root for consumer compatibility.

## 0.2.1

### Patch Changes

- 8049d2e: Expose an optional ordinary-changes refusal code and a typed missing-assigned-record error for product presentation, preserving release checks, generic messages and public inspection shape.

## 0.2.0

### Minor Changes

- 6dd2f97: Add an explicit merged-PR-tip release proof option, preserving default git-only
  behavior and all existing dirty/ignored/unreadable and nonforced-remove guards.
  Recognize the existing dispatcher exact-head and moved-head-membership evidence
  without manufacturing force or changing product refusal presentation.

## 0.1.6

### Patch Changes

- c50e702: Preserve the dispatcher's existing CC-1095 git transport guard during worktree consumption. Internal git calls and setup child environments now narrow caller protocol lists to file:git:http:https:ssh, or use that list when unset. Export the unchanged pin helpers for thin consumer adapters; retain and document the separate inherited CC-1336 config-precedence limitation.

  The mandatory protocol pin survives caller-provided identity-prefix stripping, including GIT\_, without recomputing or widening the original caller list.

## 0.1.5

### Patch Changes

- 1cb05e7: Seed the repository tests from a copied template repository instead of a fresh `git init` per test. Test-only; no runtime change.
- 2159a49: The repo-test git fixture turns off git's auto gc and maintenance in its template repository, so a detached maintenance run cannot change `.git/objects` while the template is being copied.
- 9784293: Test fixture: delete the git templates after each test file. Vitest ends worker threads without emitting `exit`, so every test run left a `wt-template-*` directory (about 2,000 files) in the temp dir.
- d251acb: Install the hostile-npmrc git script in the setup repo test through a staged copy so a concurrent fork cannot hold it open for writing (ETXTBSY).

## 0.1.4

### Patch Changes

- 816d492: Match branch names exactly when finding the worktree that holds a branch, so allocating `scout` no longer fails while `scout-2` holds its tree. `check` and `allocate` now share one preflight: `check` reports no budget refusal for an assigned worktree, and reports a refusal when the branch is checked out elsewhere, its directory is in the way, or an assigned worktree is gone with no record to re-create it.

## 0.1.3

### Patch Changes

- 2dbbb38: Release and sweep now refuse a worktree whose files git cannot vouch for. They share park's unsaved-work check: `git status --porcelain -uall`, so `status.showUntrackedFiles=no` cannot hide an untracked file; a status git cannot read (a broken gitdir) counts as dirty; and an ignored file outside node_modules, dist, coverage, .turbo and a top-level .claude refuses. Removal no longer retries with `--force` when git's own remove refuses, unless the caller forced; release and `reclaimWorktree` report that refusal instead of claiming success.

## 0.1.2

### Patch Changes

- 0c697f8: `copyClaudeDir` now lstats `<worktree>/.claude` before copying. A branch that commits `.claude` as a symlink (dangling or not), a file, or a directory no longer has the repository's `.claude` copied through it; the allocation and re-attach results report a warning instead.
- ce4fe2f: Worktree setup no longer hangs when a branch's `.npmrc` or `pnpm-workspace.yaml` is a symlink to a device such as `/dev/zero`. The base-identity guard now lstats each guarded file and treats anything that is not a regular file as changed, so setup skips before any read.
- ad65b8c: Pin `ignore-pnpmfile` in the worktree setup environment, so pnpm does not load a branch's `.pnpmfile.cjs` during setup when the branch's `.npmrc` or `package.json` asks it to. A branch `pnpm-workspace.yaml` outranks this pin; the setup step's refusal of a changed `pnpm-workspace.yaml` covers that case.
- 5605896: Worktree setup now skips the step when the tree's `.npmrc` differs from origin's default branch, as it already does for `pnpm-workspace.yaml`. A branch that adds, edits or deletes `.npmrc` gets a warning and no setup. It also pins `manage-package-manager-versions=false`, `COREPACK_ENV_FILE=0` and `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=0`. Together these stop a branch's `packageManager` field, `.npmrc` or `.corepack.env` from making setup download and run a package manager of its choosing. A base pinned to an older pnpm now installs with the host's pnpm.
- 9c04876: Skip the worktree setup step, with a warning, when the tree's `pnpm-workspace.yaml` is not byte-identical to the one at the trusted base. pnpm 10 ranks that file's `ignorePnpmfile`, `ignoreScripts` and `pnpmfile` keys above the pinned environment, so a branch could otherwise re-enable its pnpmfile hooks and lifecycle scripts during setup.

## 0.1.1

### Patch Changes

- f917afd: The setup step now runs npm with `ignore_scripts=true`, `git=git`, `node_options=--no-deprecation`, `script_shell=/bin/sh` and `shell=/bin/sh` pinned in its environment. A resumed tree's branch-controlled `package.json` and `.npmrc` can no longer run a program (lifecycle scripts, a custom git, node options or a script shell) during setup. Ports agent-chat's CC-324 fix.

## 0.1.0

### Minor Changes

- 3a0b8ab: New package: git worktree mechanics for headless agents, ported from agent-chat. `createWorktreeAllocator` allocates one branch and directory per agent under a per-repository budget (a number or a function read per allocation), adopts a crashed agent's branch, and refuses to release a tree with uncommitted or unpushed work. Also exports `inspectForRelease`, `reattachWorktree`/`recreateWorktree`, `parkWorktree`, `sweepWorktrees`/`reclaimWorktree`, the repository setup step (`runWorktreeSetup`), and the git helpers `findGitRoot`, `gitChildEnv` and `observedPresence`.
