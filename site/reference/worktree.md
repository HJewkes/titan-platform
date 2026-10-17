# worktree

**Tier 1.** No titan dependencies yet.

```sh
npm install @titan-design/worktree
```

## The problem it solves

A dispatcher that runs several agents in one repository gives each a git worktree, so their
edits cannot collide. The git side of that is easy to get wrong in ways that lose work. A
release that runs `git branch -D` deletes the only copy of an agent's unpushed commits. A
respawn that resets a crashed agent's branch does the same. Concurrent `git worktree add`
calls in one repository corrupt each other. A branch cut from the main checkout's HEAD
carries another session's unpushed commits.

The primitive is `createWorktreeAllocator`. It returns `check`, `allocate` and `release` over
plain request records. Around it sit `inspectForRelease` (is anything lost if this tree goes),
`parkWorktree` (remove the tree, keep the branch), `recreateWorktree` (put a removed tree back
at its recorded path) and `sweepWorktrees` (find trees nobody released).

## When to reach for it

Reach for it when a process allocates worktrees for agents and must keep their work safe.
The caller owns its roster, journal and isolation policy; this package only does git. So
`sweepWorktrees` takes an `ownerOf` function and a list of held allocations rather than
reading either itself.

To launch the agent process, use agent-surface. To choose an isolation
strategy per profile, use [agent-dispatch](./agent-dispatch.md).

## Example

Verified against 0.0.0 (unreleased).

```ts
import { createWorktreeAllocator, recreateWorktree } from "@titan-design/worktree";

const allocator = createWorktreeAllocator({ budget: 4 });
const alloc = await allocator.allocate({ agentName: "scout", baseCwd: process.cwd() });
// alloc.cwd is <repo>/.worktrees/scout, on branch agent-chat/scout, cut from origin's default branch.

const outcome = await allocator.release({ exitedAt: Date.now() - 300_000 }, alloc);
if (!outcome.released) console.log(`kept: ${outcome.refusal}`);

// Later, if the tree was removed but the branch kept:
await recreateWorktree({ gitRoot: alloc.ref.gitRoot!, worktree: alloc.cwd, branch: alloc.ref.branch! });
```

## What it deliberately does not do

- It does not decide policy. Which agents get a worktree, and who may release or park one, is
  the caller's call.
- It does not read a roster, a journal or a config file. The budget is a number or a function.
- It does not fetch before judging release safety. A stale local main makes release refuse
  until someone pulls, which is the over-refusal it accepts.

## Gotchas

- `release` returns `{ released: false, refusal }` rather than throwing. A refusal leaves
  everything on disk. `force` discards the agent's own work but never removes an assigned tree.
- `allocate` throws `WorktreeBudgetExhaustedError` or `WorktreeInUseError`. `check` returns
  the same conditions as `refusals` and `warnings` without changing anything.
- An existing branch for the agent's name is adopted when it holds unmerged commits and reset
  when it does not. Pass `forceReset` to discard it.
- The repository setup step is read from `.agent-chat/worktree.json` at origin's fetched
  default branch only, never from the agent's branch or a local HEAD.
- The default branch prefix is `agent-chat/`; the sweep treats only branches with the prefix
  as its own. Pass `branchPrefix` to both the allocator and the sweep to change it.
- Tests that create real repositories are named `*.repo.test.ts` and stay out of
  `pnpm test:watch`.

## Git child transport policy

`gitChildEnv`, the package's internal git calls, and `setupEnv` use the existing dispatcher's
CC-1095 policy. `pinGitProtocols(value)` intersects an explicit colon-separated list with
`file:git:http:https:ssh`; an unset value uses that list, while an empty value stays empty.
Unknown and differently cased names are discarded. Local file remotes remain supported.
Dispatcher identity prefix stripping and `GIT_TERMINAL_PROMPT=0` are preserved.
The protocol pin is derived from the original caller list and restored after custom
prefix stripping, so even a `GIT_` strip cannot erase it or widen that list.
`withPinnedGitProtocols(env)` applies only the same transport pin without stripping fields.

The existing policy is carried unchanged: when the caller leaves GIT_ALLOW_PROTOCOL unset,
its default safe list can outrank a per-command `protocol.allow=never` or
`protocol.<name>.allow=never` config. That separate inherited CC-1336 limitation is not fixed
by this extraction. Callers needing no transports can supply `GIT_ALLOW_PROTOCOL=""`.
The dispatcher retains its separate agent/shim/process environment wiring.

## Where it came from

Extracted from agent-chat's `isolation/worktree.ts`, `worktree-setup.ts`, `git.ts` and the git
halves of `park.ts` and `sweep.ts`. The strategy interface, the park blockers that read the
roster, and runtime-state bookkeeping stay with the dispatcher.

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
