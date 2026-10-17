# @titan-design/worktree

Git worktree mechanics for headless agents: allocate one branch and one directory per agent
under a per-repository budget, release or park them without losing work, re-create a removed
tree at its recorded path, and sweep for trees nobody released.

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Optional allocation groups and name-aware budgets let the caller keep separate capacity
policies without sharing slots. A requested `origin/<branch>` checkout never falls back to
the default branch; setup declarations still come only from the fetched default branch.
`release(..., { keepBranch: true })` completes a parked allocation without deleting its
branch and refuses a tree still on disk. Callers owning setup policy can use `skipSetup`.

See [the reference page](../../site/reference/worktree.md) for the API and its gotchas.

Tests that create real repositories are named `*.repo.test.ts`. `pnpm test` runs them;
`pnpm test:watch` leaves them out.
