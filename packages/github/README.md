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
carry a success and a later superseded `cancelled` run. `behind` comes from the compare API.
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
reset divided by the calls left. `jobLogTail(repo, jobId, lines)` reads an Actions job log.
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

`fakeGitHub()` is an in-memory `GitHubWire` with effect counters, for tests only.

Reference: [site/reference/github.md](../../site/reference/github.md).
