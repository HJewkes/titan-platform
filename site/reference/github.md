# github

**Tier 1 · engines.** No titan dependencies and no npm dependencies. At runtime it needs the
`gh` CLI on `PATH`, logged in; it never reads or passes a token itself.

```sh
npm install @titan-design/github
```

## The problem it solves

Automation that drives a pull request to merge calls GitHub many times, and any of those calls
can repeat after a crash. A naive retry opens a second PR, overwrites a file someone changed,
or merges a head nobody approved. Every value it passes also becomes part of a `gh api` path,
so an unchecked branch name like `../../x` reaches a different endpoint.

The primitive here is a **check-then-act port**. `GitHubWire` is one unconditional REST call per
method. `githubPort(wire)` validates every argument, reads before every write, and returns
`{ done: false, skipped }` when the effect is already in place.

A second primitive is a **pure merge decision**. `mergeReadiness` takes a snapshot the caller
already read (the PR, the branch rules, the check runs, the allowed app ids and the approved
head) and returns `ready` with a list of `blockers`, each naming why. It does no I/O, so a
workflow step can record exactly what it decided from.

## When to reach for it

Any code that reads refs, files, pull requests, required checks, check runs or job logs, or
that creates or deletes branches, commits files, opens, updates or merges pull requests, or
reruns failed jobs. Code that polls GitHub gets ETag conditional GETs and a shared rate budget
for free. Tests use `fakeGitHub()`, an in-memory wire with effect counters, instead of stubbing
`gh`. The land workflow in `products/factory` is the reference consumer.

## Example

Verified against 0.0.0 (the workspace build), on the fake wire.

```ts
import { evaluateChecks, fakeGitHub, githubPort, successRun } from "@titan-design/github";

const fake = fakeGitHub();
const port = githubPort(fake.wire);
const base = (await port.getHeadSha("o/r", "main"))!;

await port.ensureBranch("o/r", "feat/x", base);          // { sha, done: true }
await port.ensureBranch("o/r", "feat/x", base);          // { sha, done: false, skipped: "exists" }

const { pr } = await port.openPr("o/r", { head: "feat/x", base: "main", title: "x", body: "" });
fake.setRuns(pr.headSha, [successRun("validate", 1)]);
const runs = await port.latestCheckRuns("o/r", pr.headSha);
evaluateChecks(["validate", "dag-check"], runs);         // { state: "pending", pending: ["dag-check"], failing: [] }
```

Deciding a merge, where `dag-check` passed but was posted by an app that does not count:

```ts
import { GITHUB_ACTIONS_APP_ID, mergeReadiness, successRun } from "@titan-design/github";

fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2, undefined, "success", 999)]);
mergeReadiness({
  pr: await port.getPr("o/r", pr.number),
  rules: await port.requiredChecks("o/r", "main"),
  runs: await port.latestCheckRuns("o/r", pr.headSha),
  requiredApps: [GITHUB_ACTIONS_APP_ID],
  approvedHead: pr.headSha,
});
// { ready: false, blockers: [{ reason: "check-pending", detail: "dag-check has no completed run from app 15368" }] }

await port.deleteRef("o/r", { branch: "main", repo: "o/r" });                  // { done: false, skipped: "default-branch" }
await port.deleteRef("o/r", { branch: pr.headRef, repo: pr.headRepo });       // { done: true }
```

## What it deliberately does not do

- No GraphQL and no `gh pr view`. Every call is `gh api` against REST.
- No token handling. It runs on the caller's existing `gh` login.
- No polling, timeouts or retry policy. The caller owns when to read again. The rate budget
  only paces calls; it never drops one.
- No merge policy beyond readiness. Whether a ready PR may merge without a human is the
  caller's decision (`@titan-design/authority`).
- No hardcoded required checks. `requiredChecks` reads the branch's active rulesets.

## Gotchas

- `mergeableState` is computed lazily by GitHub. `unknown` is common and never means clean.
- One head can carry several runs per check name, for example a success and a later
  superseded `cancelled` run. Use `latestCheckRuns` or `latestPerName`, never the raw list.
- A required check with no run at all is `pending`, never passed.
- A bad argument throws `GitHubInputError` naming the field before `gh` runs. A write whose
  precondition changed under it throws `GitHubConflictError`. A failed `gh` call throws
  `GhError`, whose `status` is the HTTP status when `gh` reported one.
- `mergeReadiness` counts only runs whose `appId` is in `requiredApps`. Pass the runs for
  `pr.headSha`; it cannot tell which commit a run belongs to.
- `deleteRef` needs the PR's `headRepo`. A head in a fork, or a deleted fork (`null`), skips as
  `fork-head`, because a same-named branch in the base repo is not the PR's head.
- `gh api` exits 1 on a 304. The wire reads the status line that `-i` prints instead of the
  exit code, so a 304 is not an error.
- The budget is per process by default. Two processes on one `gh` login each see their own
  view until their next response updates it.
- `listOpenPrs` rows carry `behind: false` and `mergeableState` from the list, not computed
  values. Call `getPr` before deciding anything from them.
- `mergeSha` on an open PR is GitHub's test merge. It means the merge commit only once
  `merged` is true.

## Where it came from

Extracted unchanged from `products/factory/src/github/` (TP-458), with its tests. The factory
now depends on this package and its copy is deleted. `appId`, `headRepo`, `jobLogTail`,
`deleteRef`, `listOpenPrs`, the ETag cache, the rate budget and `mergeReadiness` were added for
Shepherd, the factory's PR shepherding workflow (TP-459).
