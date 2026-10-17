# @titan-design/worktree

Git worktree mechanics for headless agents: allocate one branch and one directory per agent
under a per-repository budget, release or park them without losing work, re-create a removed
tree at its recorded path, and sweep for trees nobody released.

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Git and setup child environments retain the dispatcher's existing transport pin: caller
lists are narrowed to `file:git:http:https:ssh`, and an unset list uses that same policy.
This is the existing CC-1095 mechanism, including its known CC-1336 interaction with
per-command protocol config; it does not change that policy during extraction.

See [the reference page](../../site/reference/worktree.md) for the API and its gotchas.

Tests that create real repositories are named `*.repo.test.ts`. `pnpm test` runs them;
`pnpm test:watch` leaves them out.

## Optional DEFAULT proof when parking

The two-argument `parkWorktree(target, recheck)` behavior is unchanged. A caller may opt in
with a third argument `{ allowDefaultBranchAncestor: true, fetchTimeoutMs: 1000 }`.
When the branch has no origin tracking ref, this path requires a successful fresh fetch
of origin's default branch and proves that the actual current HEAD is its ancestor.
A failed fetch or a nonpositive or nonfinite budget retains the tree and branch with
the existing missing-branch refusal. It never uses local HEAD as a fallback proof.

This opt-in path checks files, branch and HEAD again after the fetch and after the
synchronous lifecycle recheck, then uses nonforced removal. It retains the local branch.
These checks do not make removal atomic against external writers. Provider or lifecycle
policy remains with the caller.

## Sweep safety detail presentation

`SweepOptions.formatSafetyDetail` may synchronously format an already classified
`holds-work` entry. It receives a frozen copy containing only the observed `dirty`
and `unmerged` booleans. Both can be true; formatting does not change safety status
or cause another Git observation. Held, in-grace and reclaimable entries bypass it.
Without the option, entry objects and diagnostics are unchanged.

A throwing presenter rejects the report; a nonstring return throws `TypeError`.
The sweep does not reclaim trees. Caller presentation is not release authority.
