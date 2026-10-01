# @titan-design/worktree

Git worktree mechanics for headless agents: allocate one branch and one directory per agent
under a per-repository budget, release or park them without losing work, re-create a removed
tree at its recorded path, and sweep for trees nobody released.

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

See [the reference page](../../site/reference/worktree.md) for the API and its gotchas.

Tests that create real repositories are named `*.repo.test.ts`. `pnpm test` runs them;
`pnpm test:watch` leaves them out.
