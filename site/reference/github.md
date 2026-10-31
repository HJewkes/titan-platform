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
import { fakeGitHub, githubPort, successRun } from "@titan-design/github";

const fake = fakeGitHub();
const port = githubPort(fake.wire);
const base = (await port.getHeadSha("o/r", "main"))!;

await port.ensureBranch("o/r", "feat/x", base);          // { sha, done: true }
await port.ensureBranch("o/r", "feat/x", base);          // { sha, done: false, skipped: "exists" }

const { pr } = await port.openPr("o/r", { head: "feat/x", base: "main", title: "x", body: "" });
fake.setRuns(pr.headSha, [successRun("validate", 1)]);
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
await port.listPrFiles("o/r", pr.number);        // [{ path: "new/a.ts", previousPath: "old/a.ts", status: "renamed", additions: 3, deletions: 1 }]
await port.compareFiles("o/r", "main", "feat/x"); // { mergeBaseSha, files: [], truncated: false }

const marker = "<!-- shepherd:evidence -->";
await port.upsertComment("o/r", pr.number, marker, `${marker}\nchecks green`); // { id, done: true }
await port.upsertComment("o/r", pr.number, marker, `${marker}\nchecks green`); // { id, done: false, skipped: "exists" }

fake.reviewComments.set(pr.number, [{ id: 1, author: "alice", authorAssociation: "MEMBER", path: "src/a.ts", line: 12, body: "nit", resolved: false }]);
await port.listReviewComments("o/r", pr.number); // every inline comment, with its author's association and its thread's resolved state

fake.forcePushes.set(pr.number, [{ before: "<replaced head sha>", after: pr.headSha }]);
await port.listForcePushes("o/r", pr.number); // [{ before, after }], oldest first; more than 100 throws ForcePushesTruncated
```

Squash commit messages come from `formatSquashMessage`, or from the `titan-squash-message`
bin with the same input as JSON on stdin:

```ts
import { formatSquashMessage } from "@titan-design/github";

const { subject, body } = formatSquashMessage({
  title: "Add the widget",
  body: "Adds the widget.",
  prNumber: 42,
  taskIds: ["TP-1"],
  commits: [{ subject: "Add the widget core", body: "Holds no I/O,\nso tests need no fakes." }],
});
// subject: "Add the widget (TP-1) (#42)"
// body: "## Summary\n\nAdds the widget.\n\n## Changes\n\n- **Add the widget core.** Holds no I/O, so tests need no fakes.\n\nRefs: TP-1, #42"
```

CI skip tokens such as `[skip ci]` and a `skip-checks: true` trailer are defanged everywhere in
the output, code included, so a squash never skips main CI; `defangCiSkip` exposes the rewrite.

Waiting on CI for a pushed sha is `ciWait`, or the `titan-gh ci-wait` bin. The verdict itself
is pure, so a caller with its own loop can call `ciVerdict` directly:

```ts
import { ciVerdict, loadRequiredContexts } from "@titan-design/github";

const rules = await loadRequiredContexts(port, "o/r", "main"); // rulesets, else classic; a free-plan 403 reads as none
const [runs, statuses] = await Promise.all([port.checkRuns("o/r", sha), port.commitStatuses("o/r", sha)]);
ciVerdict({ rules, runs, statuses }); // { verdict: "red", reasons: ["lint=failure"] }
```

For a repo whose CI posts a commit status instead of running Actions, `statusCheckRuns(statuses,
sha, contexts)` stands each named context in as a GitHub Actions check run, so `headCheckFindings`
and every judge built on check runs counts it: `success` passes, `pending` is still running, any
other state is red, and a context with no status is a queued run that holds the head.

```
$ titan-gh ci-wait o/r 1a2b3c4 --timeout 600
GREEN o/r 1a2b3c4d...   # exit 0; RED exits 1, TIMEOUT exits 2, a usage error or unknown sha exits 64
```

A required context is green only on `success`: skipped and neutral are red, as a merge gate
judges them. An unpinned one counts only from GitHub Actions or a commit status. With no
required contexts every run and status must pass, and a sha with statuses but no check-run
stays pending, because statuses can land before the check suites exist.

PR state for a shell or an agent comes from the `titan-gh` bin, over the caller's `gh` login:

```sh
titan-gh pr-status octo/widgets#42
# octo/widgets#42 open 1a2b3c4 clean checks 1/2 validate:failure blocked: check-failed
titan-gh pr-status octo/widgets#42 --json   # { repo, number, state, headSha, baseRef, mergeableState, checks, ready, blockers }
titan-gh pr-context octo/widgets#42         # title, base, head sha, changed files, then the body
```

`pr-status` judges the head with `mergeReadiness` against the base's required checks (rulesets,
or classic protection when the rulesets require none) and drops the `unapproved` blocker, since
approval lives in Shepherd. `pr-context` lists no files past GitHub's 3,000-file cap and gives
the count instead. A bad verb or ref prints usage and exits 64.

Why CI failed comes from `titan-gh ci-failures`, in place of `gh run view --log-failed | grep`:

```sh
titan-gh ci-failures octo/widgets#42             # every failing Actions job at the head, at most 5
# FAILED unit https://github.com/octo/widgets/actions/runs/9/job/7
# first failure: FAIL  src/widget.test.ts > widget > renders
# Test Files  1 failed | 3 passed (4)
# last 20 lines: ...
titan-gh ci-failures octo/widgets --job 7 --lines 40   # one job by its check run id
titan-gh ci-failures octo/widgets#42 --json      # { repo, number, headSha, jobs, skipped }
```

It strips ANSI codes and Actions timestamps, then picks the first vitest failure line, the
`Test Files` and `Tests` summary, any `ERROR: Coverage` or obsolete-snapshot line, and the log
tail. A log with none of those prints the tail, marked unrecognised. A PR with no failing job
prints `no failing Actions job at <head7>` and exits 0; bad arguments exit 2.

The gate before a merge is `titan-gh premerge`. The caller owns verdicts and passes the head its
approval named:

```sh
titan-gh premerge octo/widgets#42 "$HEAD" --approved-head "$REVIEWED" --clone ~/src/widgets
# OK octo/widgets#42 head=1a2b... base=main req=[validate] strict=true behind=0   (exit 0)
# FAIL octo/widgets#42: checks red: validate=failure                              (exit 1)
titan-gh premerge octo/widgets#42 "$HEAD" --approved-head "$HEAD" --json
# { repo, number, ok, reasons, head, base, required, strict, behindBy }
```

It fails on a closed, merged or draft PR, a head other than the given sha, a required check
that is not green as `ciVerdict` judges it, a strict ruleset with the head behind, a conflict,
or an approved head that `approvedHeadWalk` cannot reach through base merges. A merge gate
fails closed on conflicts. With `--clone`, the bin runs `git merge-tree --write-tree` in that
clone, which must be fetched and hold the commits: once for the walk's tree proof, and once to
merge the head into the base tip GitHub reports now. That merge uses the tip's sha, never a local
`origin/<base>` ref, which can be stale or shadowed by a branch or tag of that name, so fetch the
base before the call: a conflict, a git error or a missing tip commit fails. The bin is the only
place that runs git. Without `--clone`, an approved head other than the PR head fails, and
conflicts rest on GitHub's mergeability: `dirty` fails, and `unknown` is re-read after 1, 2 and
4 seconds and fails if it is still unknown. Bad arguments, including a sha that is not 40 lower-case hex characters, print usage
and exit 2.

## What it deliberately does not do

- No `gh pr view`, and no GraphQL but for `listReviewComments`, `listForcePushes` and
  `readBackstopSnapshot`. Every call is `gh api`; only those post to `graphql`, because GitHub
  reports a review thread's resolved state and a force-push's replaced head nowhere in REST,
  and the backstop needs many PRs' rollups in one request.
- No token handling. It runs on the caller's existing `gh` login.
- No polling, timeouts or retry policy outside `ciWait`. Every other read leaves when to read
  again to the caller. The rate budget only paces calls; it never drops one.
- No merge policy beyond readiness. Whether a ready PR may merge without a human is the
  caller's decision (`@titan-design/authority`).
- No hardcoded required checks. `requiredChecks` reads the branch's active rulesets.

## Gotchas

- `mergeableState` is computed lazily by GitHub. `unknown` is common and never means clean.
- One head can carry several runs per check name, for example a success and a later
  superseded `cancelled` run. `mergeReadiness` wants every run from `checkRuns`, so a
  superseded red run still blocks the merge.
- `checkRuns` lists runs as GitHub's default `filter=latest` does: a rerun of a job in the
  same workflow run hides that job's earlier attempts. A reader of attempt order, such as
  "which run came after my rerun", uses `checkRunAttempts`, which asks for `filter=all`.
  The fake hides superseded attempts of one workflow run the same way.
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
- `revalidateOpenPrs(repo, etag)` is the poller's form of `listOpenPrs`: it sends the caller's
  ETag and answers `{ notModified: true }` on a 304, which GitHub charges no rate-limit point.
  A list longer than one page answers with a null `etag`, because one ETag covers one page. A
  change to `mergeableState` or `behind` alone does not change the ETag. The fake counts each
  304 in `notModified`.
- GitHub silently caps `pulls/{n}/files` at 3,000 files. `listPrFiles` compares the list with
  the PR's `changed_files` and throws `FileListTruncatedError` (`expected`, `received`) when the
  list is short. Treat that as "cannot decide", not as an empty list; a protected-path check
  fed a partial list would fail open.
- GitHub silently caps `pulls/{n}/commits` at the first 250 commits (`PR_COMMITS_CAP`).
  `listPrCommits` returns the shas oldest first and does not detect the cap; a caller checks
  that the last sha is the PR's head and treats any other list as short.
- `listDefaultBranchCommits(repo, since)` returns `{ sha, message }` for every commit on the
  default branch committed at or after `since`, newest first, all pages. A wide `since` on a busy
  repo is many pages; keep it to the window you need.
- `listForcePushes` reads one GraphQL page of `FORCE_PUSHES_CAP` (100) head force-pushes and
  throws `ForcePushesTruncated` when GitHub says there are more. Treat that as "cannot decide",
  never as the whole list. `before` is null when GitHub no longer has the replaced commit.
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
- `mergedAt` is GitHub's ISO merge timestamp (REST `merged_at`), null until the PR merges.

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

### Ancestry and pull-head reads

`compareAncestry(repo, base, head)` is on the wire, the port and `fakeGitHub`. It answers the
compare API's `status` for `base...head`: `ahead` (`base` is an ancestor of `head`), `behind`,
`identical` or `diverged`. A 404 answers `missing`: GitHub has not got one of the commits, which
just after a push can mean it has not caught up, so treat it as "read again", not as proof. A
status it does not know and any other failed read throw. It reads one page of one commit, since
only `status` matters.

`lsRemotePullHead(exec, remoteUrl, n, { env, timeoutMs })` runs
`git ls-remote -- <remoteUrl> refs/pull/<n>/head` through a `GitExec` (`execGit`, or
`fake.gitExec`) and answers the sha, or null when the remote has no such ref. It reads git's
transport, not REST, so it is a second, independent source for a PR head. A credential goes in
`env` (for example `GIT_CONFIG_*` entries carrying an `http.extraHeader`), never on argv:
`remoteUrl` must be an `https:` or `file:` URL with no user or password, and is refused with
`GitHubInputError` before git runs otherwise. `GIT_TERMINAL_PROMPT=0` is always set. A git that
cannot run, exits non-zero or prints no object id throws `LsRemoteError`, with the `env` values
and token-shaped strings cut from the message; a failed read is never a sha. Only an exact
`refs/pull/<n>/head` line counts, because git matches the pattern against the tail of each ref.

`lsRemoteBranchHead(exec, remoteUrl, branch, { env, timeoutMs })` reads `refs/heads/<branch>`
the same way, with the same URL, credential and failure rules, so a branch tip has the same
second source. `branch` must be a plain branch name (no glob, `..`, `//`, leading dash or
slash, trailing dot or slash, or `.lock` suffix) and is refused with `GitHubInputError` before
git runs otherwise.

The fake answers both from its own history: `compareAncestry` walks `fake.commits` parents
(ref names resolve to their tips, and PR heads count as known), and `fake.gitExec` answers each
PR's current head. `readFaults.compareAncestry` and `readFaults.lsRemote` fail the next read.

### Backstop snapshot read

`readBackstopSnapshot(api, { repo, branch, since, mainCursor, doneSince })` takes a `Rest`
transport directly (it is not on the port) and reads one repo for a reconciler backstop with
one GraphQL query:

- `open`: every open PR with its head commit's rollup contexts (`kind: "check"` with
  `databaseId, name, status, conclusion, completedAt`, or `kind: "status"` with
  `context, state, createdAt`) and its reviews, oldest first.
- `done`: merged and closed PRs, newest first, until `updatedAt` is older than `doneSince` less
  `DONE_OVERLAP_MS` (10 min). `mergedBy` is the login.
- `main`: the branch `tip` and its history since `since`, newest first, stopping before
  `mainCursor`.
- `rateLimit`: `cost` summed over every query sent, `remaining` and `resetAt` from the last,
  and `queries`.

Every range is read whole. A later page re-sends the same document with only the ranges that
still have pages included, and a `contexts` or `reviews` connection with more pages is re-read
for that one commit or PR. A range that would need a page past `BACKSTOP_CAPS` (main 20 pages
= 1,000 commits, done 10 pages = 200 PRs, open 20, contexts and reviews 10 follow-up pages)
throws `BackstopTruncated` with `range` and `cap`: treat it as "cannot decide", and do not move
the cursor. Unlike `listForcePushes`, any GraphQL `errors` entry fails the read even when
`data` came back beside it, because a partial snapshot reads as a PR with no CI or no review.
GraphQL has no conditional requests, so the caller decides when a snapshot is worth sending.
`snapshotRequests` and `graphqlPoints` compute GitHub's cost formula: a full page set of every
range is 203 requests, 2 points.

## Where it came from

Extracted unchanged from `products/factory/src/github/` (TP-458), with its tests. The factory
now depends on this package and its copy is deleted. `appId`, `headRepo`, `jobLogTail`,
`deleteRef`, `listOpenPrs`, the ETag cache, the rate budget and `mergeReadiness` were added for
Shepherd, the factory's PR shepherding workflow (TP-459). `listPrFiles`, `compareFiles` and
`upsertComment` followed for its conflict and evidence steps (TP-517), and `listReviewComments`
for the review wake brief (TP-1003). `listForcePushes` replaced the factory's product-side
GraphQL reader for the carry seat check (TP-1649).
