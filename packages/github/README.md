# @titan-design/github

GitHub REST port over the gh CLI: validated paths, required checks from branch rules, and an in-memory fake

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

`GitHubWire` is one GitHub call per method, unconditional, the way GitHub itself behaves.
`ghCliWire()` implements it by running `gh api` with an argv array, never a shell, on the
caller's existing `gh` login; nothing here reads or passes a token. `githubPort(wire)` puts
check-then-act on top: every write reads first and reports `{ done: false, skipped }` when its
effect is already in place, so a step that repeats after a crash repeats no effect.

| Write | Reads first | Guard GitHub enforces |
| --- | --- | --- |
| `ensureBranch` | the ref | none |
| `deleteRef` | the head's repo, the default branch, then the ref; a fork head or the default branch skips | none |
| `putFile` | the file on the branch; identical content skips | `sha` = expected blob |
| `openPr` | open, then merged, PRs for the head | none |
| `updateBranch` | the PR: merged, head moved or not behind skips | `expected_head_sha` |
| `pushEmptyCommit` | the branch's ref: absent or moved past the expected head skips | the ref moves only as a fast-forward |
| `merge` | the PR: merged returns the stored merge SHA; a moved head skips | `sha` = the approved head |
| `rerunFailed` | the Actions run; not completed skips | none |
| `upsertComment` | the PR's comments; one containing the marker skips | none |

`githubPort` validates every argument before any wire call, because each one becomes part of a
`gh api` path. It checks five things. The repo is `owner/name` of `[A-Za-z0-9._-]`, and neither
part is `.` or `..`. A branch or ref follows git's ref-name rules and has no `?`, `#` or `%`. A sha is
40 lower-case hex characters. A PR number or run id is a positive safe integer. A content path is
relative, with no `.`, `..` or empty segment and no `?` or `#`. A bad value throws
`GitHubInputError` naming the field, and `gh` never runs.

`requiredChecks` reads the branch's active rulesets (`rules/branches/<base>`), never a
hardcoded list. `latestCheckRuns` keeps the newest run per check name, because one head can
carry a success and a later superseded `cancelled` run; a run with no start is ordered by id
unless it is still queued, which makes it newest. `behind` comes from the compare API.
`mergeReadiness` (and `headCheckFindings` under it) is the one rule for whether a required check
passed: a required name needs a completed `success` run, so a `skipped` or `neutral` run, or no run
at all, never passes.

`mergeReadiness({ pr, rules, runs, requiredApps, approvedHead })` is pure. It is ready only when
the PR is open, not a draft, not conflicting, up to date when the rules are strict, at exactly
the approved head, the rules name at least one required context, and every required context
has a completed run concluding `success` from an app in `requiredApps`
(`GITHUB_ACTIONS_APP_ID`, 15368, on this owner's repos) at `pr.headSha`. A run from any other
app, or at any other sha, never counts. Every counted run must be green (`success`,
`neutral` or `skipped`), superseded or not, required or not, so an older red run of a
re-run check still blocks and so does one still queued or in progress. Pass it every run,
from `checkRuns`, never `latestCheckRuns`. Every not-ready result lists `blockers`, each
with a `reason` and a `detail`.

Every call runs `gh api -i`, so the wire sees the status line and headers. A GET sends the
ETag of the same request's last 200 as `If-None-Match`, and a 304 answers with that cached
body. Lists follow `Link: rel="next"` page by page, each page conditional on its own ETag, and
only to `api.github.com`. One `RateBudget` per process (`sharedRateBudget`, or pass `budget`)
reads `x-ratelimit-*`; below 500 remaining core calls, each call waits the time left until
reset divided by the calls left. `jobLogTail(repo, jobId, lines)` reads an Actions job log, and `jobSteps(repo, jobId)` its steps.

`octokitWire({ client?, appToken? })` is the same port for a long-running service, over Octokit
instead of one `gh` process per call. `octokitRest(client)` implements the `Rest` interface
with the same ETag cache, 304 rules and next-page guard. The client, `octokitClient()`, or
`sharedOctokit()` for one per process, behaves like this:
- It reads its token from `gh auth token`, holds it in memory only, and re-reads it once on a 401.
- `@octokit/plugin-throttling` waits out `retry-after` and `x-ratelimit-reset` and spaces writes.
  A GET is retried once when the wait is a minute or less. A write is never retried.
- `@octokit/plugin-retry` retries 5xx answers on GET and HEAD only, so a write that may have
  landed is never sent twice.
- Errors carry the status and a redacted message, with no body and no token.
- It has the same rate-floor guard as `restCaller`, and its GraphQL deadline only:
  - Every call first acquires `sharedRateBudget`, or the client's `budget`, so below `RATE_FLOOR` remaining, calls spread over the time left.
  - A GraphQL call fails after `GRAPHQL_TIMEOUT_MS` (30 s). `restCaller` also kills a core REST call's `gh` and fails it after `CORE_TIMEOUT_MS` (60 s); a timed-out read is not retried. The Octokit core lane has no deadline yet.

`client.budget()` reports the last `x-ratelimit-*` window per lane (`rest`, `graphql`), and the
cooldowns the throttle is still waiting out. `createCheckRun` posts as the App on its own
client and throttle key. `appInstallationTokenOverHttp` mints the App's token over that path.
`ghCliWire` stays as the wire for CLI processes such as `titan-gh`.
`listOpenPrs(repo, headPrefix?)` lists open PRs; list rows carry no `behind` or
`mergeableState`.

`listPrFiles(repo, pr)` returns every changed file of a PR, all pages, with `previousPath` on a
rename. GitHub stops that list at 3,000 files without saying so, so the port compares the count
with the PR's own `changed_files` and throws `FileListTruncatedError` when fewer came back. A
caller must treat that error as "cannot decide" (for example, hold the PR for a human), never as
an empty or partial list. `compareFiles(repo, base, head)` returns `{ mergeBaseSha, files,
truncated }`. GitHub caps compare at 300 files and 250 commits, also silently; `truncated` is
true when `files` reaches 300 or the commits returned are fewer than `total_commits`. When it is
true, `files` may be missing paths: fall back to `listPrFiles` for a PR, or treat the result as
unknown. `listPrCommits(repo, pr)` returns the PR's commit shas oldest first; GitHub stops at
the first 250 (`PR_COMMITS_CAP`), so a list whose last sha is not the head is short.
`listDefaultBranchCommits(repo, since)` returns `{ sha, message }` for each default-branch commit
committed at or after `since`, newest first, all pages.
`listForcePushes(repo, pr)` returns the PR's head force-pushes oldest first, each as `{ before,
after }`: the head it replaced (null once GitHub no longer has that commit) and the new head.
REST timeline events name only the new head, so this one read posts to GraphQL
(`HeadRefForcePushedEvent`) on the same `gh` login. It reads one page of `FORCE_PUSHES_CAP` (100)
and throws `ForcePushesTruncated` when there are more, never a short list. The fake reads
`fake.forcePushes`, a map of PR number to pushes.
`upsertComment(repo, pr, marker, body)` lists the PR's comments first and posts only
when none by the authenticated `gh` user has `marker` (an HTML comment the caller builds, also
put in `body`) alone on a line; trailing whitespace on that line still counts. Another author's comment or a longer marker never counts. Under a GitHub App installation token,
`GET /user` is 403, so pass the app's bot login: `githubPort(wire, { login: "my-app[bot]" })`
(`GET /app` needs an App JWT, so config is the only path that works with the installation token). Two
concurrent callers can both post; there is no lock. Each read carries the same ETag cache and
rate budget as the others.

`formatSquashMessage({ title, body, prNumber, taskIds, commits })` is pure and builds a squash
commit message: a subject of the PR title, any task id the title does not already name, and
`(#<pr>)`; a body of `## Summary` (the PR body), `## Changes` (one `- **<subject>.** <body>`
bullet per commit) and `Refs: <task ids>, #<pr>`. Author text passes through as written: only a
plain paragraph in a commit body is joined onto one line, and headings, setext underlines,
lists, blockquotes, tables, HTML and code keep their own lines. It drops `Co-authored-by` and
`Signed-off-by` trailers, the "Generated with Claude Code" line, standalone email addresses
and any commit merging main into the branch, but never touches code (fenced, indented or
inline) or an address inside a URL or ssh remote. GitHub's own squash text is recognised only
in a commit whose subject ends `(#<n>)`, the one place GitHub writes it: there a `---------`
line followed only by trailers is dropped and a `* <subject>` header standing alone loses its
star, so an author's lists and rules pass through everywhere else. An empty PR body omits
`## Summary`, and an empty title leaves the subject as `(#<pr>)`. The same input always gives
byte-identical output, and formatting its own output again (as title and body) changes
nothing: only the exact Changes and Refs tail it would write is cut from the PR body, so an
author's own `## Changes` or `Refs:` stays. The `titan-squash-message` bin reads the same
input as JSON on stdin and prints the subject, a blank line and the body, or `{ subject, body }`
with `--json`; bad input exits 2 naming the field.

`ciVerdict({ rules, runs, statuses })` is pure and folds a sha's check-runs and commit statuses
into `{ verdict: "green" | "red" | "pending", reasons }`. With required contexts, each must be
`success` from its pinned app, else from GitHub Actions (15368) or a commit status; a skipped or
neutral required context is red, and runs that are not required are ignored. With none, every
run and status must pass and at least one check-run must exist. `loadRequiredContexts(port,
repo, branch)` reads rulesets, then classic protection; both reads treat a free-plan 403
("Upgrade to GitHub Pro") as no rules and throw on any other 403. `resolveCommit(repo, sha)`
expands an abbreviation (null when GitHub has no such commit) and `commitStatuses(repo, sha)`
reads the combined status. `ciWait(port, options)` polls those until green, red or the deadline,
reading the rules once and retrying a failed read. The `titan-gh` bin wraps it:

```
titan-gh ci-wait <owner/repo> <sha> [--base <branch>] [--timeout <seconds>] [--interval <seconds>]
```

It prints `GREEN <repo> <sha>`, `RED <repo> <sha>: <name>=<conclusion>; ...` or
`TIMEOUT <repo> <sha> after <n>s: pending <names>`, and exits 0 green, 1 red, 2 timeout (run it
again) and 64 on bad arguments or a sha GitHub does not have. Defaults: 540 second timeout,
30 second interval, the repo's default branch.

Its `pr-status` and `pr-context` verbs read one PR over the caller's `gh` login, in place of `gh pr view --json`
piped to `jq`. `titan-gh pr-status <owner/repo#N>` prints one line: state (`open`, `draft`,
`closed` or `merged`), the head's first seven characters, `mergeableState`, how many required
checks passed with each non-passing one as `name:state`, and `ready` or the `mergeReadiness`
blocker reasons. Required checks come from the base's rulesets, or from classic protection when
the rulesets require none. Approval lives in Shepherd, not on GitHub, so it never reports
`unapproved`. `titan-gh pr-context <owner/repo#N>` prints the title, base, head sha, changed
files and body for a reviewer; past GitHub's 3,000-file cap it gives the count and lists none.
`--json` prints either as one object; an unknown verb or a ref that is not `owner/repo#N` prints
usage and exits 64.

`titan-gh ci-failures <owner/repo#N>` replaces `gh run view --log-failed` piped through `sed` and
`grep`. For each failing Actions check run at the PR head (at most five; the rest are named as
skipped) it reads the last 400 lines of the job log and prints the job name and url, the first
vitest failure line (`FAIL `, `×` or `✗`), the `Test Files` and `Tests` summary, any
`ERROR: Coverage` or obsolete-snapshot line, and the last `--lines` lines (default 20), with ANSI
codes and Actions timestamps stripped. A log with none of those lines prints the tail, marked
unrecognised. `titan-gh ci-failures <owner/repo> --job <id>` digests one job by its check run id.
`--json` prints `{ repo, number, headSha, jobs: [{ job, id, url, digest }], skipped }`. A PR with
no failing job prints `no failing Actions job at <head7>` and exits 0; bad arguments exit 2.
`digestJobLog(log)` and `ciFailures(port, target)` in `src/ci-failures.ts` are the core.

`titan-gh premerge <owner/repo#N> <sha> --approved-head <sha> [--clone <dir>] [--json]` is the
read-only half of agent-chat's `scripts/seat/premerge`; the caller looks up the verdict and passes
the head it approved. It reads the PR, the base's required contexts, the head's check runs and
statuses, and the compare, then fails on a PR that is closed, merged or a draft, a head other than
`<sha>`, a red or pending required check (judged as `ciVerdict` judges them), a strict ruleset with
the head behind, a conflict, or an approved head `approvedHeadWalk` cannot reach. With
`--clone <dir>`, a fetched local clone, the bin runs `git merge-tree --write-tree` there: once to
prove the walk, and once to merge the head into the base tip GitHub reports now, by sha, failing on
a conflict, a git error, or a clone that lacks that commit. It never trusts a local `origin/<base>`,
which can be stale or shadowed, so fetch the base first. Without it, an approved head other than the PR head fails, and a conflict rests on GitHub's
mergeability: `unknown` is re-read after 1, 2 and 4 seconds and fails if it never resolves. It prints
`OK <repo>#<N> head=<sha> base=<base> req=[<contexts>] strict=<bool> behind=<n>` or
`FAIL <repo>#<N>: <reason>; ...`, and exits 0, 1, or 2 on usage. `--json` prints
`{ repo, number, ok, reasons, head, base, required, strict, behindBy }`.

`classifyGitHubFailure(input)` is a pure classifier for a failed GitHub answer: status (absent for
a network failure), lower-cased headers, redacted message, method, a `networkError` flag, the
prior `streak` and `now` (epoch ms; it reads no clock). It returns `ok`, `auth` (401), `error`
(a 403 or 422 naming no rate limit, secondary limit, abuse or spam, and other 4xx), `unknown` (a
5xx or network failure on a write) or `unavailable { resetAt, source, bucket, callClass }` (any
429; a 403 with `retry-after`, remaining 0 or limit text; a 422 naming a limit; a 5xx or network
failure on a read). `resetAt` is `retry-after`, else `x-ratelimit-reset`, else `now` + 60 s
doubling per streak step to 15 min (`nextResetAt`); a header beyond 61 min is clamped and flagged
in `reason`. `RATE_LIMIT_PHRASES` is the one list of body phrases. `githubApiPool` calls it.

`githubApiPool({ identity, send, clock, state? })` gates every call one GitHub identity makes.
`pool.run(priority, callClass, call)` queues `call`, hands it to `send` when granted, and resolves
to `send`'s answer or to `{ unavailable: { resetAt, reason, class } }`; an unavailable call never
throws (a throw from `send` itself is passed on). Grants go by `POOL_PRIORITY` (1 outbox and
lander, 2 pacer, 3 item reads, 4 backstop), first come first served within one. Mutations are a
single-flight lane: none overlap, and each starts at least `MUTATION_SPACING_MS` (1000) after the
last one started; reads are not serialised. An `unavailable` answer closes its (identity, call
class) pair until `resetAt` and adds one to that pair's streak; while it is closed the pair
grants nothing and the identity's other classes grant only priority 1. A success resets only its
own pair's streak; `unknown` and `error` answers pass through and change nothing. Calls already in
flight when their pair trips count as the same trip. State lives in a `PoolStateStore`, by
default `memoryPoolStateStore()`, one per pool; a product passes a durable one. `clock` supplies
`now()` and `sleep(ms)`. Reopening still happens at `resetAt` with no probe or canary.

`fakeGitHub()` is an in-memory `GitHubWire` with effect counters, for tests only.

Reference: [site/reference/github.md](../../site/reference/github.md).
