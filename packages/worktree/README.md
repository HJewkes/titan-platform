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

## Explicit merged PR tip evidence

Release remains git-only by default. `createWorktreeAllocator({ releaseProof: "git-or-merged-pr-tip" })` opts into the existing dispatcher CC792/CC624 proof: when local content checks cannot prove landing, bounded `gh pr view --json state,headRefOid,commits` may establish that the exact local tip is the merged PR head or belongs to that merged PR's commits after its head moved. OPEN/CLOSED, mismatched or later local tips, malformed/missing output and command failure cannot establish landing. The GitHub CLI probe uses the caller's configured account and repository; tests use owned fake binaries only. No login or credentials are provisioned here.

`inspectForRelease(root, tree, branch, base, "git-or-merged-pr-tip")` exposes the same explicit inspection. The `ReleaseProof` type is exported. Omitting the option or passing `"git"` preserves the previous git-only behavior and diagnostic-only GH query. Sweep and park defaults are unchanged.

This changes commit-landing evidence only. Hidden untracked files, ignored files no build regenerates, unreadable status/ignored listings, grace and assigned-tree guards still refuse or exempt exactly as before. A nonforced git-remove refusal retains its tree and branch; there is no new force bridge or automatic force retry. Caller `force` semantics remain unchanged.

The legacy product release path has weaker file-loss detection and auto-force retry; it is not claimed equivalent. A merged PR proof must never override these stronger generic checks. Product-specific refusal presentation remains outside this change. Native GitHub compatibility/account access, actual released consumption and TP640's remaining deletion acceptance are not certified by synthetic fixtures.

## Typed refusal presentation

A failed allocator release may additionally return `refusalCode: "unsaved-changes"` when its only blocking observations are ordinary nonempty git status results. The release remains false and its existing `refusal` message stays unchanged. Callers can use the code to present their own ordinary-dirt wording without parsing a diagnostic. An unmerged branch, grace refusal, ignored files, failed status/ignored listing, mixed earlier/later unsafe observations or refused removal does not receive that code. Earlier refusals remain binding even if a provider removes their original cause. The code classifies the guard's observations; it is never permission to remove files.

`MissingAssignedWorktreeRecordError` is exported with `worktreePath`. Allocation throws it under the existing missing-assigned-tree/missing-or-mismatched-record condition, with the same generic message as before. A product can catch this specific class to present its own wording; it must rethrow unrelated errors. No additional adoption or removal authority is granted.

`inspectForRelease` keeps its original object shape and diagnostics. The shared internal inspection records the existing file probes rather than running a second inspection for presentation. These additive fields/types do not certify agent-chat's remaining setup, park, sweep or dependency migration acceptance.
