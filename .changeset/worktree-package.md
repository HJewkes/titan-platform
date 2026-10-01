---
"@titan-design/worktree": minor
---

New package: git worktree mechanics for headless agents, ported from agent-chat. `createWorktreeAllocator` allocates one branch and directory per agent under a per-repository budget (a number or a function read per allocation), adopts a crashed agent's branch, and refuses to release a tree with uncommitted or unpushed work. Also exports `inspectForRelease`, `reattachWorktree`/`recreateWorktree`, `parkWorktree`, `sweepWorktrees`/`reclaimWorktree`, the repository setup step (`runWorktreeSetup`), and the git helpers `findGitRoot`, `gitChildEnv` and `observedPresence`.
