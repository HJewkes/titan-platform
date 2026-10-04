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
  runs: await port.checkRuns("o/r", pr.headSha),
  requiredApps: [GITHUB_ACTIONS_APP_ID],
  approvedHead: pr.headSha,
});
// { ready: false, blockers: [{ reason: "check-pending", detail: "dag-check has no completed run from app 15368" }] }

await port.deleteRef("o/r", { branch: "main", repo: "o/r" });                  // { done: false, skipped: "default-branch" }
await port.deleteRef("o/r", { branch: pr.headRef, repo: pr.headRepo });       // { done: true }
```

Reading a PR's changes and leaving one evidence comment, on the fake wire:

```ts
fake.prFiles.set(pr.number, [{ path: "new/a.ts", previousPath: "old/a.ts", status: "renamed" }]);
await port.listPrFiles("o/r", pr.number);        // [{ path: "new/a.ts", previousPath: "old/a.ts", status: "renamed" }]
await port.compareFiles("o/r", "main", "feat/x"); // { mergeBaseSha, files: [], truncated: false }

const marker = "<!-- shepherd:evidence -->";
await port.upsertComment("o/r", pr.number, marker, `${marker}\nchecks green`); // { id, done: true }
await port.upsertComment("o/r", pr.number, marker, `${marker}\nchecks green`); // { id, done: false, skipped: "exists" }

fake.reviewComments.set(pr.number, [{ id: 1, author: "alice", authorAssociation: "MEMBER", path: "src/a.ts", line: 12, body: "nit", resolved: false }]);
await port.listReviewComments("o/r", pr.number); // every inline comment, with its author's association and its thread's resolved state
```

## What it deliberately does not do

- No `gh pr view`, and no GraphQL but for `listReviewComments`. Every call is `gh api`; only
  `listReviewComments` posts to `graphql`, because GitHub reports a review thread's resolved state
  nowhere in REST.
- No token handling. It runs on the caller's existing `gh` login.
- No polling, timeouts or retry policy. The caller owns when to read again. The rate budget
  only paces calls; it never drops one.
- No merge policy beyond readiness. Whether a ready PR may merge without a human is the
  caller's decision (`@titan-design/authority`).
- No hardcoded required checks. `requiredChecks` reads the branch's active rulesets.

## Gotchas

- `mergeableState` is computed lazily by GitHub. `unknown` is common and never means clean.
- One head can carry several runs per check name, for example a success and a later
  superseded `cancelled` run. `evaluateChecks` wants `latestCheckRuns`; `mergeReadiness`
  wants every run from `checkRuns`, so a superseded red run still blocks the merge.
- A required check with no run at all is `pending`, never passed.
- A bad argument throws `GitHubInputError` naming the field before `gh` runs. A write whose
  precondition changed under it throws `GitHubConflictError`. A failed `gh` call throws
  `GhError`, whose `status` is the HTTP status when `gh` reported one.
- `mergeReadiness` counts only runs whose `appId` is in `requiredApps` and whose `headSha` is
  the PR's head, matching authority's MRG-AU-RV. A required context passes only on
  `success`; `neutral` and `skipped` pass for other checks. An empty required-context list
  refuses as `no-required-checks`, and an unfinished extra check holds the merge.
- Branch names with `%` are refused, because GitHub decodes the path and `%2e%2e` would
  become `..`.
- `deleteRef` needs the PR's `headRepo`. A head in a fork, or a deleted fork (`null`), skips as
  `fork-head`, because a same-named branch in the base repo is not the PR's head.
- `gh api` exits 1 on a 304. The wire reads the status line that `-i` prints instead of the
  exit code, so a 304 is not an error.
- The budget is per process by default. Two processes on one `gh` login each see their own
  view until their next response updates it.
- `listOpenPrs` rows carry `behind: false` and `mergeableState` from the list, not computed
  values. Call `getPr` before deciding anything from them.
- GitHub silently caps `pulls/{n}/files` at 3,000 files. `listPrFiles` compares the list with
  the PR's `changed_files` and throws `FileListTruncatedError` (`expected`, `received`) when the
  list is short. Treat that as "cannot decide", not as an empty list; a protected-path check
  fed a partial list would fail open.
- GitHub silently caps compare at 300 files and 250 commits. `compareFiles` sets `truncated`
  when `files` reaches 300 or fewer commits came back than `total_commits`. When `truncated`
  is true, `files` may be missing paths: read `listPrFiles` instead, or treat the result as
  unknown.
- `upsertComment` counts only comments by the authenticated `gh` user (resolved once per port
  with `GET /user`) that hold the marker alone on a line. A forged marker from another author,
  or a longer marker containing yours, does not suppress the post. Two concurrent callers can
  both post; there is no lock.
- `upsertComment` never edits. A comment that already holds the marker stays as it is, so put
  the marker in `body` or the next call posts again.
- `compareFiles` lists new paths only; a rename appears under its new name. Use `listPrFiles`
  when the old path matters.
- `mergeSha` on an open PR is GitHub's test merge. It means the merge commit only once
  `merged` is true.

### Check runs under a GitHub App

`appInstallationToken({ appId, installationId, privateKeyPem, now })` signs an RS256 JWT with
`node:crypto` (`iss` is the app id, `iat` 60 s in the past, `exp` under 10 minutes) and exchanges
it at `/app/installations/{id}/access_tokens`. It returns `{ token, expiresAtMs }`. A malformed
key throws `GitHubInputError` before `gh` runs, and an exchange that answers an already expired
token throws.

`createCheckRun(repo, { name, headSha, conclusion, title, summary, externalId })` is on the
wire, the port and `fakeGitHub`. `conclusion` is `success`, `failure` or `action_required`; any
other value throws `GitHubInputError` before a wire call. `ghCliWire(exec, { appToken })` calls
the provider for each run and hands the token to `gh` as `GH_TOKEN` in the child env of that one
call (`GhExecOptions.env`), never in argv and never in `process.env`. An error from the
exchange or the post has the token, the JWT and the PEM replaced with `[redacted]`, and so does any string shaped like
a GitHub token (`ghs_`, `ghu_`, `gho_`, `ghp_`, `ghr_`, `github_pat_`) or a three-part JWT, in
stdout, stderr and the thrown message, even when `appToken` itself rejects while quoting one.
A token split across stdout and stderr is cut from both halves. A wire built
without `appToken` refuses `createCheckRun`. `fakeGitHub({ appId })` records the run under that
app id (default `FAKE_APP_ID`), so `latestCheckRuns` returns it; each posted run is also
appended to `fake.createdCheckRuns` as `{ id, repo, request }`.

## Where it came from

Extracted unchanged from `products/factory/src/github/` (TP-458), with its tests. The factory
now depends on this package and its copy is deleted. `appId`, `headRepo`, `jobLogTail`,
`deleteRef`, `listOpenPrs`, the ETag cache, the rate budget and `mergeReadiness` were added for
Shepherd, the factory's PR shepherding workflow (TP-459). `listPrFiles`, `compareFiles` and
`upsertComment` followed for its conflict and evidence steps (TP-517), and `listReviewComments`
for the review wake brief (TP-1003).
