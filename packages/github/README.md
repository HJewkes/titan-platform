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
| `putFile` | the file on the branch; identical content skips | `sha` = expected blob |
| `openPr` | open, then merged, PRs for the head | none |
| `updateBranch` | the PR: merged, head moved or not behind skips | `expected_head_sha` |
| `merge` | the PR: merged returns the stored merge SHA; a moved head skips | `sha` = the approved head |
| `rerunFailed` | the Actions run; not completed skips | none |

`githubPort` validates every argument before any wire call, because each one becomes part of a
`gh api` path. It checks five things. The repo is `owner/name` of `[A-Za-z0-9._-]`, and neither
part is `.` or `..`. A branch or ref follows git's ref-name rules and has no `?` or `#`. A sha is
40 lower-case hex characters. A PR number or run id is a positive safe integer. A content path is
relative, with no `.`, `..` or empty segment and no `?` or `#`. A bad value throws
`GitHubInputError` naming the field, and `gh` never runs.

`requiredChecks` reads the branch's active rulesets (`rules/branches/<base>`), never a
hardcoded list. `latestCheckRuns` keeps the newest run per check name, because one head can
carry a success and a later superseded `cancelled` run. `behind` comes from the compare API.
`evaluateChecks(required, latestRuns)` folds those into `pending`, `passed` or `failed`; a
required name with no run is pending, never passed.

`fakeGitHub()` is an in-memory `GitHubWire` with effect counters, for tests only.

Reference: [site/reference/github.md](../../site/reference/github.md).
