# @titan-design/worktree

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
