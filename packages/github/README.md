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
| `merge` | the PR: merged returns the stored merge SHA; a moved head skips | `sha` = the approved head |
| `rerunFailed` | the Actions run; not completed skips | none |

`githubPort` validates every argument before any wire call, because each one becomes part of a
`gh api` path. It checks five things. The repo is `owner/name` of `[A-Za-z0-9._-]`, and neither
part is `.` or `..`. A branch or ref follows git's ref-name rules and has no `?`, `#` or `%`. A sha is
40 lower-case hex characters. A PR number or run id is a positive safe integer. A content path is
relative, with no `.`, `..` or empty segment and no `?` or `#`. A bad value throws
`GitHubInputError` naming the field, and `gh` never runs.

`requiredChecks` reads the branch's active rulesets (`rules/branches/<base>`), never a
hardcoded list. `latestCheckRuns` keeps the newest run per check name, because one head can
carry a success and a later superseded `cancelled` run. `behind` comes from the compare API.
`evaluateChecks(required, latestRuns)` folds those into `pending`, `passed` or `failed`; a
required name with no run is pending, never passed.

`mergeReadiness({ pr, rules, runs, requiredApps, approvedHead })` is pure. It is ready only when
the PR is open, not a draft, not conflicting, up to date when the rules are strict, at exactly
the approved head, and every required context has a passing latest run from an app in
`requiredApps` (`GITHUB_ACTIONS_APP_ID`, 15368, on this owner's repos) at `pr.headSha`. A run
from any other app, or at any other sha, never counts. Any latest counted run that is not
passing blocks, required or not, including one still queued or in progress. Every
not-ready result lists `blockers`, each with a `reason` and a `detail`.

Every call runs `gh api -i`, so the wire sees the status line and headers. A GET sends the
ETag of the same request's last 200 as `If-None-Match`, and a 304 answers with that cached
body. Lists follow `Link: rel="next"` page by page, each page conditional on its own ETag, and
only to `api.github.com`. One `RateBudget` per process (`sharedRateBudget`, or pass `budget`)
reads `x-ratelimit-*`; below 500 remaining core calls, each call waits the time left until
reset divided by the calls left. `jobLogTail(repo, jobId, lines)` reads an Actions job log.
`listOpenPrs(repo, headPrefix?)` lists open PRs; list rows carry no `behind` or
`mergeableState`.

`fakeGitHub()` is an in-memory `GitHubWire` with effect counters, for tests only.

Reference: [site/reference/github.md](../../site/reference/github.md).
