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
