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

## Strict default-branch fetch

`fetchDefaultTip(gitRoot, timeoutMs)` fetches origin's current default branch and returns `{ sha, ref }`, or the existing failure-reason string. It never substitutes the local HEAD. It honors origin/HEAD when known; otherwise it tries main then master within one shared timeout budget. Fetch updates only the remote-tracking ref, leaving the main checkout's HEAD and files unchanged.

This exposes the existing helper unchanged for callers such as park checks that must refuse when origin cannot establish containment. `resolveBranchBase` retains its separate local-HEAD fallback and warning for allocation. A successful fetch is only a commit observation; the caller must still perform its ancestry, ownership and file-loss checks. Setup, park and sweep policies are unchanged.

## Setup browser cache protection

Setup pins `PLAYWRIGHT_SKIP_BROWSER_GC=1`, including when the caller supplies `0` or leaves it unset. This preserves the product's standard Playwright browser-cache GC opt-out for setup running outside a permission profile; it does not change setup trust or command execution policy.

## Setup outcome reports

`setupWorktree(target, run?)` returns `{ outcome, warnings }`: `ran` after successful execution, `none` for no declared step, `skipped` for an existing trust/validation guard, or `failed` after an unsuccessful step. `runWorktreeSetup` remains the warnings-only wrapper and invokes setup once. Output remains in the existing setup log rather than the report.

`SetupTarget.baseSha` and `fetched` are caller assertions, not origin authentication. Callers must derive the target from the approved fetched default branch; a requested checkout branch does not acquire setup authority. The allocator's default-branch selection and all existing guards are unchanged. Product dependency guidance and metadata remain the caller's responsibility.

The root entry also exports the existing guarded filenames `NPMRC_FILE` (`.npmrc`) and `PNPM_WORKSPACE_FILE` (`pnpm-workspace.yaml`) for callers sharing setup diagnostics and fixtures. Their values and guard behavior are unchanged.

## Opt-in setup target data

`includeSetupTarget: true` includes `allocation.setupTarget` only when the operation selected a setup base. Omitted or false preserves the previous return shape; an existing assigned tree has no target. Recreation carries its actual selected target. The flag alone does not suppress automatic setup.

The value reuses `SetupTarget` and describes this operation's selection; it is not authentication or a transferable permission. A diagnostic local-HEAD fallback remains `fetched: false`. Do not reconstruct or reassociate a target from persisted references or a requested checkout branch. The setup source, warnings, execution order and timeouts are unchanged.

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

Worktree adds disable checkout hooks for that invocation only (`-c core.hooksPath=/dev/null`), preserving dispatcher CC410. Later git commands retain repository hooks. Timeout/late cleanup uses the original add target despite that prefix. Fetch/reference-transaction hooks are outside this unchanged preservation slice.
