# @titan-design/worktree

## 0.1.1

### Patch Changes

- f917afd: The setup step now runs npm with `ignore_scripts=true`, `git=git`, `node_options=--no-deprecation`, `script_shell=/bin/sh` and `shell=/bin/sh` pinned in its environment. A resumed tree's branch-controlled `package.json` and `.npmrc` can no longer run a program (lifecycle scripts, a custom git, node options or a script shell) during setup. Ports agent-chat's CC-324 fix.

## 0.1.0

### Minor Changes

- 3a0b8ab: New package: git worktree mechanics for headless agents, ported from agent-chat. `createWorktreeAllocator` allocates one branch and directory per agent under a per-repository budget (a number or a function read per allocation), adopts a crashed agent's branch, and refuses to release a tree with uncommitted or unpushed work. Also exports `inspectForRelease`, `reattachWorktree`/`recreateWorktree`, `parkWorktree`, `sweepWorktrees`/`reclaimWorktree`, the repository setup step (`runWorktreeSetup`), and the git helpers `findGitRoot`, `gitChildEnv` and `observedPresence`.
