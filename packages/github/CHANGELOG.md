# @titan-design/github

## 0.12.0

### Minor Changes

- 581c26f: Add the reconciler's `BotActionUnlogged` detector (TP-3094 C7). The backstop snapshot now reads each review's author and commit, each status's creator, and every `shepherd-train/**` branch head. The reconciler matches the bot's reviews, statuses, merges and train pushes against factory intent rows (`merge_op` for merges, a new append-only `factory_bot_intent` table for the rest), raises `ops-alarm BotActionUnlogged <repo> <kind> <id>` once per action, and marks it not-factory so it never counts as a factory approval. `BotPorts` gains the bot's `login`.
- b458a20: `CheckRun` gains `completedAt` (null until the run completes) and `title` (the run's `output.title`, null when it set none), mapped from `completed_at` and `output.title` by `listCheckRuns` on both the gh and Octokit wires (TP-3522). Both are required fields, so an external implementer of `GitHubWire` or a hand-built `CheckRun` must add them.
- 83a5759: Recover a CI job that GitHub leaves queued or in progress after its workflow run has completed (TP-3996). `ci-wait` used to count such a job as a runner backlog and waited on toward the 135-minute ceiling with the merge train held. Now, once the job's run reads completed for 5 minutes, land reruns that one job in a recorded `ci-orphan-rerun` step, once per head. If the head orphans again, the run fails as a `ci-timeout`. The GitHub port gains `workflowRunStatus` and `rerunJob(repo, runId, jobId)`, which reads the run before it posts. The fake now reads a run with an open job as not completed.
- 5f2d9ed: `githubApiPool` reopens a closed (identity, call class) pair through a `GET /rate_limit` probe of the tripped bucket and exactly one canary call: the pair opens only when the canary returns ok, and `onAvailable(identity, class, resetAt)` fires once per reopen. An unavailable canary doubles the streak; a failed or 5xx probe re-arms at 60 s without doubling. A 401 puts the whole identity in auth state, fires `onAuthFailed` once per transition, skips the probe, and clears only on `pool.tokenChanged()` or a restart. The pool now requires a `probe` option. `probeVerdict`, `probedBucket` and `PROBE_REARM_MS` are exported. `octokitClient` gains `poolOwnsWaits` (off by default), under which the throttle never waits or retries inside a call.
- d3d9a04: Add `githubApiPool`, which gates one GitHub identity's calls: grants by priority (1 outbox and lander, 2 pacer, 3 item reads, 4 backstop) then first come first served, a single-flight mutation lane spaced 1000 ms apart, and per-(identity, call class) state that closes a limited pair until its reset, doubles only that pair's streak, and holds the identity's other classes to priority 1 meanwhile. `pool.run` returns a limited call as an `Unavailable` value instead of throwing. State goes through a `PoolStateStore`, in memory by default.
- 123f2d0: Add `revalidateRef(repo, branch, etag)` and `revalidateRulesets(repo, etag)` to `GitHubPort` and `GitHubWire`, beside `revalidateOpenPrs`. Both send `If-None-Match` and answer `notModified` on a 304. `revalidateRulesets` maps each ruleset id to its `updated_at`, reading a ruleset's detail only when its list row lacks one, and answers `unreadable` for a free-plan 403.
- dcaebb9: Adds `lsRemoteBranchHead(exec, remoteUrl, branch, options)`: `git ls-remote` for `refs/heads/<branch>`, with the same credential-in-env, URL and failure rules as `lsRemotePullHead`, so a branch tip has git's transport as a second source too. A branch name that is not a plain ref name is refused before git runs.
- 24f1577: Add `parseGitHubToken`, which accepts the text of a classic `ghp_` or fine-grained `github_pat_` personal access token file and never quotes the input in its error.
- 423c9ce: `shepherd prs` rows now carry what `gh pr checks` prints. `ci` gains `checks` (the newest run per name with its status, conclusion, times, link and title), `statuses` (the head's commit statuses, which the PR snapshot now reads beside its runs on the same cadence), `required` (the run's land-rules contexts) and `settled`. `ci.head` is the sha the cached runs were read for, so a list whose head moved since shows the mismatch. `CommitStatus` gains optional `targetUrl`, `description`, `createdAt` and `updatedAt`, mapped by the gh-cli wire.
- a2da8ac: `formatSquashMessage` defangs CI skip tokens (TP-2653). The five bracketed skip forms GitHub documents (skip ci, ci skip, no ci, skip actions, actions skip), in any case or inner spacing, have their square brackets turned into parentheses, and a skip-checks trailer set to true loses its colon, in the subject and the whole body, code included, so a squash merge can no longer skip main CI and Release. Re-formatting the output still changes nothing. The rewrite is exported as `defangCiSkip`, and the factory's squash fallback (plain title when formatting throws) applies it to the title.
- d130bd8: `GitHubPort.checkRunAttempts(repo, sha)` lists every run on a sha with each rerun's earlier attempts kept, by asking GitHub for `filter=all`; `GitHubWire.listCheckRuns` takes that filter as an optional third argument. `checkRuns` is unchanged and keeps GitHub's default `filter=latest`, which hides a rerun job's earlier attempts in the same workflow run; its doc now says so. The fake models that default: `listCheckRuns` without the filter hides superseded attempts of one workflow run.
- db14121: `fileBytes(repo, path, ref, { maxBytes })` refuses a file whose contents entry reports a size over `maxBytes`, or no numeric size, by throwing the new `BlobTooLargeError` before any `git/blobs` download. `GitHubWire.getContentBytes` takes the cap as a fourth argument, the port refuses a cap that is not a positive integer, and the fake refuses stored bytes over the cap the same way.
- 5833044: Add `fileBytes(repo, path, ref)` to `GitHubPort` and `getContentBytes` to `GitHubWire`: a byte-exact file read for binary content such as PNG snapshots, which `getFile` corrupts by decoding UTF-8. A file the contents API does not inline (over 1 MB, `encoding: "none"`) is read through `git/blobs/{sha}`, and a decoded length that differs from the reported size throws. The fake gains a `bytes` map, falling back to `files` encoded as UTF-8.
- 84114b3: Adds `statusCheckRuns(statuses, sha, contexts)`, which stands each named commit-status context in as a GitHub Actions check run so the check-run judges count CI that posts a status: `success` passes, `pending` is running, any other state is red, and a context with no status is a queued run (TP-4645).

### Patch Changes

- 7b53127: Send REST reads as `gh api -i <path>?<query>` instead of `-X GET` with `-f` fields, so a gh shim can classify them as reads.
- b3209e3: - **Git fixtures on test-kit (TP-4485).** `git-merge-tree.test.ts` copies a test-kit template repository per test and writes its branches with one `withHistory` fast-import. No runtime change.
- a2df0c0: `ciVerdict` judges an unpinned required context on its newest GitHub Actions run and its commit status together. It is green only when every source that reported succeeded, pending when either is still going or neither reported, and red otherwise, naming the run's conclusion first. Before, a `success` commit status made the context green even beside a newer failed or still-running Actions run of the same name, and a successful run hid a red status. Pinned contexts and the all-runs rule are unchanged.
- 0b09ff1: The Octokit client fails a hung REST call after `CORE_TIMEOUT_MS` (60 s), like `restCaller`, and does not retry it (TP-2936).
- 63ccb71: Typed-lint burn-down (TP-2187): the package source and tests no longer rely on unsafe type assertions. `getBranchProtected` now types the branch answer as possibly empty, which matches the runtime guard it already had. No behaviour change.
- 2f306ce: Split the in-memory `fakeGitHub` wire handlers into named functions; no behaviour change.
- 181c229: Adds a `titan-squash-message` regression test showing that CI skip tokens and `skip-checks: true` in the title, body and commits do not survive into the squash message. Test only; no production code changes.
- 449504e: Read a check run that has a conclusion and a completion time as finished even when GitHub leaves its status at `in_progress`; export `isConcluded`.

## 0.11.0

### Minor Changes

- 0dd6186: Add `readBackstopSnapshot`: one repo's open PRs with head rollup contexts and reviews, recently closed PRs, and main history since a cursor, read over GraphQL with every range paged whole. A range past its cap throws `BackstopTruncated`, any GraphQL `errors` entry fails the read, and the snapshot carries GitHub's reported `rateLimit` cost. `snapshotRequests` and `graphqlPoints` compute the query's cost.
- 6a0952d: Add `GitHubPort.closePr`: closes an open PR without merging it and leaves its branch. A PR already closed or merged skips as `closed` or `merged`.
- 8c89092: Add `compareAncestry(repo, base, head)` to `GitHubWire` and `GitHubPort`: the compare API's `status` as `ahead`, `behind`, `identical` or `diverged`, and `missing` on a 404. Add `lsRemotePullHead(exec, remoteUrl, n)`, which reads `refs/pull/<n>/head` through `git ls-remote` and answers the sha or null; the credential rides in the child env, a URL carrying one is refused, and a failed read throws `LsRemoteError`. New exports `Ancestry`, `GitExec`, `execGit`, `LsRemoteOptions` and `LsRemoteError`. `fakeGitHub` answers both from its history: `compareAncestry` walks `commits`, and `fake.gitExec` answers each PR's head.
- 6281b49: Add `mergeIntoBranch` to `GitHubWire` and `GitHubPort`: GitHub's Merges API merges a commit into a branch without a pull request. A 201 answers `merged` with the merge commit sha, a 204 answers `already-contained`, a 409 answers `conflict`, and any other status throws. The fake records each call in `branchMerges` and answers a conflict for any head in `mergeConflicts`.
- 65287ec: `titan-factory shepherd prs [owner/repo] --json` lists every open PR of each seat repo, or of the one named, from Shepherd's PR snapshot, plus the PRs Shepherd merged in the last 24 hours. Each row carries the branch, head, base, state, title, body, draft flag, whether Shepherd has it registered (with its run id and phase), the snapshot's cached CI for the head when it holds one, its source and when it was read. Open rows answer with no GitHub call while the open list is under a minute old, and concurrent callers share one list read. A merged row's `mergeSha` comes from the run's merge step, never from a PR read. A seat repo with no run in it is still listed.

  `@titan-design/github`: `PullRequest` gains optional `title` and `body`, which the gh wire now fills from the REST answer (a null body reads as an empty string).

- 1476172: Add `titan-gh ci-failures`: a digest of each failing Actions job (first failing test, vitest summary, coverage miss, log tail) for a PR or one job (TP-2319).
- 102a9df: Add `titan-gh premerge <owner/repo#N> <sha> --approved-head <sha> [--clone <dir>] [--json]`: the read-only half of agent-chat's `scripts/seat/premerge`. It checks PR state, the head sha, required checks and statuses, strict behind and the approved-head walk, and prints `OK ... head= base= req=[] strict= behind=` or `FAIL <repo>#<N>: <reasons>`, exiting 0, 1, or 2 on usage. With `--clone`, the bin runs `git merge-tree --write-tree` in that clone to prove a walked approval and to merge the head into the base branch's current tip, read from GitHub and passed by sha (never a local, possibly stale `origin/<base>`), failing on a conflict, a git error or a clone without that commit. Without it, an approved head other than the PR head fails, and GitHub's `unknown` mergeability is re-read a few times and then fails, never passes. `PullRequest` gains an optional `behindBy`, which `getPr` fills from the compare for an open PR.
- be96d75: Add `approvedHeadWalk` and `MAX_BASE_MERGES`: follow first parents from a PR head through two-parent merges of the base branch to an approved head, check each base parent is on the base and inside the newest, and require the head's tree to equal a clean merge of the newest base parent into the approved head (`cleanMergeTree`, supplied by the caller; missing or failing, the walk refuses). Otherwise it gives premerge's reasons. `mergeReadiness` takes the walk as `approvalWalk`, so an approval of an earlier head reached that way no longer reports `head-moved`.
- 82d8c0a: Bind the sh-fix-proof run to the registered PR and base branch, so a run for another PR at the same head cannot supply the result (TP-2357 b). `CheckRun.pullRequests` is a new required field, so an external implementer of `GitHubWire` or a hand-built `CheckRun` must add it (an empty array when the run names no PR).
- c278211: checks.ts is the one check-judging core: export `isSucceeded` (moved from readiness) and `isPassingConclusion`. `latestPerName` now treats a run with no `startedAt` that has not completed as newest, so a queued rerun shadows an older result and reads pending; a completed run with no start, like an equal start, orders by the higher id.
- 69f323c: Add `setPrBase` to the GitHub port and wire. It retargets an open PR onto another base with one `PATCH repos/{repo}/pulls/{pr}` whose body carries only `base`. The port reads the PR first and skips a merged, closed or already-retargeted PR. The fake records each retarget in `baseChanges`.
- 027f0f2: Add `octokitWire`, the GitHub port over Octokit for long-running services (TP-2561 b1). It behaves like this:

  - `@octokit/plugin-throttling` waits out rate limits and spaces writes.
  - `@octokit/plugin-retry` retries GET and HEAD only.
  - ETag reads keep the existing cache and 304 rules.
  - The token comes from `gh auth token`, is held in memory, and is re-read once on a 401.
  - Parity with `restCaller`: every call acquires `sharedRateBudget` (the `RATE_FLOOR` pacing), and a GraphQL call times out at 30 s.

  New exports: `octokitClient`, `sharedOctokit`, `octokitRest`, `GitHubRequestError`, the `Rest` and `Fields` types, and `appInstallationTokenOverHttp`. `client.budget()` reports the live rate windows and throttle cooldowns. `ghCliWire` is unchanged.

- 608b103: `Commit` gains an optional `message`, which the gh adapter reads from the git commits API. Shepherd's ci-wait no longer waits out its 45 minutes on a head GitHub Actions started no run for: past a 5 minute grace, a conflicting head goes to the conflict fix round, and a skip token in the head commit message wakes the fixer to push a fresh commit. An unsettled mergeable state or a failed read keeps the wait as before.
- 8c25894: Add `jobSteps(repo, jobId)` to `GitHubPort` (wire: `getJobSteps`): an Actions job's steps in run order, each with its name and conclusion. The fake answers from `fake.jobSteps` and 404s a job with none seeded.

  Shepherd's frozen-main and base-red holds now count a head's failing check as the base's only when it fails there at the same job step, and every failing test id (or, with no vitest heading, every error line) in the head's job log also fails there. A check that fails at another step, fails a test the base does not, or whose step or log cannot be read, wakes the fixer. So does one whose log may hold a failure it does not name: an unhandled error or worker crash, a tail cut inside vitest's failure output, headings that number other than the summary's failed tests and suites, or a step that timed out or was cancelled.

- 6eab4e8: Add `classifyGitHubFailure` and `nextResetAt`: a pure classifier that turns a failed GitHub answer into ok, unavailable (with `resetAt`, source, bucket and call class), unknown, auth or error, with the 60 s doubling to a 15 min cap (TP-3395, slice a of TP-3096). No existing export changes.

### Patch Changes

- b0fb3e6: `ghCliWire` rejects a pull request whose REST `state` is neither `open` nor `closed`, instead of passing it through where a "not open" check reads it as closed (TP-2358 a).
- 4ffd52a: `ciVerdict` builds on checks.ts: any unfinished run of a required context and app reads pending whatever its start time or id, and once every run has completed the newest is `latestPerName`'s pick (a null or tied start goes to the higher id). Success is `isSucceeded` and the all-runs rule uses `isPassing`. Its own conclusion set and picker are gone.
- 8438a4e: Read Actions job logs with `--allow-escape-sequences` and strip the colour codes, so `jobLogTail` stops failing with "HTTP 200" (TP-2665); `failureOf` no longer reports a 2xx as an HTTP error.
- 216db04: The fake GitHub's merge now moves the PR's base branch to the merge sha, as GitHub does. Before, the base branch stayed on its pre-merge sha, and the fake's default compare read that stale tip as a newer push containing the merge.
- e6dafd1: `restCaller` passes `CORE_TIMEOUT_MS` (60 s) to `gh` for every core REST call, so a hung `gh` is killed and the call rejects instead of never settling (TP-2933 a).
- 77e2c4d: `fakeGitHub`'s `deleteRef` now closes every open PR based on the deleted branch, as GitHub's API delete does (TP-2962 a).

## 0.10.0

### Minor Changes

- 61511e7: Add `pr-status` and `pr-context` verbs to the `titan-gh` bin: `pr-status <owner/repo#N>` prints one line of PR state, required checks and merge readiness, and `pr-context` prints title, base, head, changed files and body; `--json` prints either as an object.

## 0.9.0

### Minor Changes

- cd830c1: Add `ciVerdict`, `loadRequiredContexts` and `ciWait`, plus the `titan-gh ci-wait` bin: wait for a sha's CI over the base branch's required contexts and exit 0 green, 1 red, 2 timeout or 64 on a usage error or unknown sha. The port gains `resolveCommit` and `commitStatuses`; rulesets and classic protection now read a free-plan "Upgrade to GitHub Pro" 403 as no rules, and rules of an unexpected shape throw.

## 0.8.0

### Minor Changes

- 579886b: `PullRequest` now carries `autoMerge`, read from the REST `auto_merge` field. Shepherd's `shepherd/review` publish reads it, so a PR with auto-merge armed gets `action_required` rather than `success`; an unreadable PR is treated as armed.

## 0.7.1

### Patch Changes

- 369a00b: The rate budget now tracks GraphQL rate headers apart from core and paces `listReviewComments` against them, and a GraphQL call times out after 30 seconds instead of hanging.

## 0.7.0

### Minor Changes

- c0701a9: `GitHubPort.defaultBranch(repo)` reads the repo's default branch, and `GitHubPort.merge` takes an optional `expectedBase`: a PR on another base skips as `base-changed`, checked before the write and before each retry. The land core now records a `base-check` before every merge. An approved head whose pull request is based on anything but the default branch waits in `base-wait`, with no timeout, until the pull request is retargeted; a Shepherd run gives its repo's merge train up before it waits. An approval or policy allow covers one base: after a retarget the run re-reads the merge evidence and decides again, the `approve-merge` prompt names the base, and an approval never follows to a head on another base. A green read that names a new base re-reads the branch rules. A seat's `merge-into-feature-base` grant lets its runs merge into a stacked pull request's own base. `shepherd status` names the refused base as the next action.
- 91eea82: Pass the formatted squash message on every land merge. `GitHubPort.merge` takes an optional `{ subject, body }` that the wire sends as `commit_title` and `commit_message`; the port gains `getSquashSource` (title, body and commit messages) so a caller can build the `formatSquashMessage` input. The factory's land merge step formats the PR's title, body and commits with the run's task id and merges with that message, falling back to the plain title and an empty body (and a warning) when formatting throws.
- e4dd79b: `land-rules` no longer fails every run on a private free-plan repo (TP-1899). When the rules read answers HTTP 403 "Upgrade to GitHub Pro" and the branch endpoint reports `protected: false`, the base reads as requiring no checks, so `ci-wait` requires every check-run at the head to be green. Any other 403, a `protected: true` or an unreadable branch still refuses. `@titan-design/github` gains `branchProtected` on the port and `getBranchProtected` on the wire.
- 845a0cf: Add `formatSquashMessage` and the `titan-squash-message` bin: a pure, deterministic squash commit message built from the PR title, body, task ids and commits, laid out as `## Summary`, `## Changes` (one bolded bullet per commit) and `Refs:`. Author markdown passes through as written: only plain commit-body paragraphs are joined onto one line. It strips Co-authored-by and Signed-off-by trailers, standalone email addresses (never inside code, URLs or ssh remotes) and the Claude Code line, recognises GitHub's `---------` separator and `* ` commit headers only in a commit GitHub squash-merged, and drops merges of main. Re-formatting its own output changes nothing.

## 0.6.0

### Minor Changes

- 944ef91: Shepherd judges a main commit by the base branch's required contexts (rulesets, then classic protection, with per-context app pins) instead of every Actions job. A red non-required job such as `release` records a warning and no longer freezes the repo; a repo with no rules, or a rules read that fails, keeps the all-checks rule. The github port gains `classicRequiredChecks` and `RequiredChecks.pins`.
- 7f4e467: Add `listDefaultBranchCommits(repo, since)` to the port: every default-branch commit committed at or after `since`, as `{ sha, message }` (`LoggedCommit`), newest first. The fake answers it from `history`.
- 116dd59: Remove `evaluateChecks` and the `ChecksVerdict` type. It counted `skipped` and `neutral` as passed for a required check, which disagreed with `headCheckFindings` and `mergeReadiness`, where a required context needs a completed `success` run. Use `mergeReadiness` (or `headCheckFindings`) as the one rule. `isPassing` and `latestPerName` are unchanged.

  Importers checked before removal, `git grep -E 'evaluateChecks|ChecksVerdict'` on each default branch: titan-platform origin/main f4b073d4 (only prose in changelogs, no code importer), active-work d30d9562: 0, agent-chat 93838463: 0, codewatch dc9f4eff: 0, relay e7a47577: 0, brain 760ce01a: 0.

- 484fadc: `merge` and `rerunFailed` now survive a 5xx or an unreadable answer. Each failed write is followed by a read-back: a PR merged at the pinned head, or a run that is queued again, counts as done. Otherwise the write is sent once more, still pinned to the same head, and a second failure throws `WriteRetriesExhaustedError` naming the step. A 4xx is never retried. The fake GitHub gains `mergeFaults` and `rerunFaults`.

### Patch Changes

- 5facf32: Retry a comment post that fails with a 5xx or an unreadable answer: each retry first reads the PR's comments back and counts an existing marker comment as done, so the Shepherd merge-evidence comment is never posted twice. `GitHubPortOptions.sleep` injects the backoff wait.
- 501b7c2: Give the `execGh` timeout test a per-run sleeper marker, so a concurrent run of the suite on one host can no longer fail its "leaves no gh child alive" check or have its sleeper killed.
- b97a26d: Carry a pull request's merge time as `PullRequest.mergedAt` (`string | null`), mapped from REST `merged_at` and stamped by the fake on merge.
- d4db9bc: `PrFile` carries `additions` and `deletions` from the PR's file list, read from the same `pulls/{n}/files` call as before.
- d186dfb: `updateBranch` sends its PUT once more, with the same expected head, after an empty or unparseable answer or a 5xx. A 422 head mismatch on that retry reads as already updated; any other second failure rethrows the first error. gh's "unexpected end of JSON input" now counts as transient for reads too.

## 0.5.1

### Patch Changes

- 9891e0d: Retry a gh read that fails with HTTP 5xx, a connection error or an unparseable body, up to three attempts with a short backoff. A 200 is cached for ETag revalidation only once its body parses, so the retry of an unparseable body is unconditional. Writes are never repeated; update-branch re-reads the PR when its answer cannot be parsed.

## 0.5.0

### Minor Changes

- c8ab11b: Add `listReviewComments` to the GitHub port: every inline review comment on a PR with its reviewer, path, line, body and resolved state. The `gh` adapter reads it from GraphQL review threads, the only place GitHub reports resolution; `fakeGitHub` serves it from `reviewComments`.
- 92e76c5: Add `revalidateOpenPrs`, a conditional open-PR list sent with the caller's ETag. A 304 answers `notModified`, which GitHub charges no rate-limit point. The fake answers 304 the same way and counts each one in `notModified`.
- 113cac1: Shepherd's seat check on a carried MERGE now reads seat reviewers at every commit the PR passed through since the reviewed head, not only the heads the run reviewed, so a FIX_FIRST at an unreviewed update refuses the carry. An unreadable or short commit list, or more than 50 heads, refuses too. `@titan-design/github` adds `listPrCommits` and `PR_COMMITS_CAP` to the port, wire and fake.
- 4ed86e8: Add `listForcePushes` to the GitHub port: a PR's head force-pushes with the head each replaced and the new head, read through GraphQL on the port's `gh` login, capped at one page of 100 with `ForcePushesTruncated` past it. `fakeGitHub()` seeds them through `fake.forcePushes`. The factory's carry seat check now reads force-pushes through the port, and its product-side reader is deleted.

### Patch Changes

- 041125d: The token exchange and `createCheckRun` error paths now scrub anything shaped like a GitHub token or a JWT, including a token split across stdout and stderr and one quoted by a rejecting `appToken`, instead of relying on a closed `"token":"x"` pair.
- 6385c70: Scrub token shapes from every `gh api` error and GraphQL error message, not only the exchange and check-run paths. The JWT shape no longer matches dotted names such as `eyJson.config.js`; a classic 40-hex token after a token keyword and a URL-encoded `ghs%5F` token are now redacted; a whole token at the end of stdout no longer eats the first word of stderr; and a token split by a trailing newline on stdout is cut from both streams.
- f0db7a9: Close the remaining token-redaction gaps: a 40-hex token after `GH_TOKEN=`, `"access_token":` or as URL userinfo, a JWT right after an underscore, a split across stdout and stderr past any whitespace or a trailing keyword, and the Link next URL in a refused-page error. A dotted file name that only opens like a JWT is no longer redacted.
- 170ed76: Token redaction now covers `https://<hex>:x-oauth-basic@host`, a keyword and hex run split across stdout and stderr at any offset, percent-encoded separators (`%26token=`, `access_token%3D`, `Bearer%20<JWT>`), long gaps after `token:`, and JWTs with a short payload segment, and the keyword lookbehind is linear so a megabyte of whitespace no longer stalls it.
- 13e505a: Close three token redaction gaps. A JWT is now found from the dot behind its header, so a long run of JWT-shaped words such as `-eyJaaa-eyJaaa...` is scanned in linear time. `redactStreams` now cuts URL userinfo that only stderr completes (`https://HEX` then `:x-oauth-basic@h`, or `https://u:HEX` then `@h`). It also cuts the tail of a token split after its prefix even when stdout already ends in a whole token's worth, so the first word of stderr after a token that ends stdout is now cut with it.
- 6b19eac: `redactStreams` redacts an exact secret whose bytes straddle the stdout/stderr seam. The early return that keeps each stream on its own looked only at token-shaped spans, so a secret split across the streams reached neither half whole and showed in both.
- 10a66c3: `redactStreams` deduplicates the secret list before its exact-secret scans, so repeated secrets no longer multiply the spans, and its doc names the whitespace-secret-cut-at-the-seam limit.

## 0.4.0

### Minor Changes

- 620a34f: Create check runs under a GitHub App installation token. Add `appInstallationToken` (an RS256 JWT signed with `node:crypto`, exchanged at `/app/installations/{id}/access_tokens`) and `signAppJwt`; add `createCheckRun` to the wire, the port and `fakeGitHub`, which records the run under a configurable `appId`. `conclusion` is typed `success`, `failure` or `action_required` and any other value throws `GitHubInputError` before a wire call. `ghCliWire` takes an `appToken` provider and passes the token as `GH_TOKEN` in the child env of that one call; `GhExecOptions` gains `env`. Errors never contain the token, the JWT or the PEM.
- f390fc0: Export a non-throwing `isRepo` predicate for bare `owner/name` slugs. `checkRepo` now shares its grammar: it applies GitHub's owner rules and refuses a `.git` suffix.

## 0.3.2

### Patch Changes

- e54f34e: `getBranchRules` throws a named error when a `required_status_checks` rule carries no check list, instead of reading it as no required contexts.

## 0.3.1

### Patch Changes

- 3eca440: Shepherd treats an `update-branch` HTTP 422 "merge conflict between base and head" as a conflict instead of failing the run: it wakes the fixer, and opens `approve-merge` only if the conflict survives one wake. A run that reads a new head cancels its own pending `approve-merge` and `sh-sent-back` gates for an older head. `WorkflowContext` gains `expireGates(reason, isStale)`, and the fake GitHub gains `updateBranchConflict`.

## 0.3.0

### Minor Changes

- 1873696: Add `pushEmptyCommit` to `GitHubPort`: it pushes a commit with the head's own tree onto a branch so CI runs again, and skips when the branch moved. The wire gains `createCommit` and `updateRef`, `getCommit` reports the commit's `tree`, and the fake counts `updateRef` effects.

## 0.2.0

### Minor Changes

- 679866f: `reviewRulesBypassable(repo, branch)` reports whether the caller can bypass every pull-request rule on a branch, read from `rules/branches` and each ruleset's `current_user_can_bypass`. The fake gains a settable `reviewBypass`.
- 83e6c69: `githubPort(wire, { login })` takes the bot login that `upsertComment` owns comments as, so it works under a GitHub App installation token where `GET /user` is 403. A marker line with trailing whitespace now counts as a match.
- 06ffd8c: `Commit` gains an optional `committedAt`, the committer date, which the `gh api` wire reads from `git/commits`. The factory's `land` now refreshes a behind PR in a repo without strict required checks when its base moved after the head's last green run: before a green verdict goes on to approve-merge, `ci-wait` compares the base tip's committer date with the earliest start of the head's latest required GitHub Actions runs. A base tip committed later, or one with no readable date or run start, is treated as moved, so the verdict is `behind` and the existing update-branch path runs under the same update cap before CI is awaited at the new head. A strict repo keeps its behaviour.

### Patch Changes

- ccbdde0: `checkPath` now refuses a path containing `%`, as `checkRef` already did. A segment such as `%2e%2e` or `%2F` passed validation, and a URL layer could decode it into `..` or `/`.

## 0.1.0

### Minor Changes

- 9b01c07: `land` judges checks over every run at the head with `mergeReadiness` semantics: a red run of a required context blocks even beside a newer green one, a required context needs a run concluding `success` (neutral and skipped no longer pass), and only GitHub Actions runs count, so any red Actions run at the head is `ci-failed`. `@titan-design/github` exports `headCheckFindings`, the check evaluation `mergeReadiness` now delegates to, with `CheckFinding` and `HeadChecksInput`.
- ced913f: Add `@titan-design/github`: the factory's GitHub REST port (`githubPort`, `ghCliWire`, `evaluateChecks`, `latestPerName`, argument validation and the `fakeGitHub` test wire), moved unchanged with its tests. The factory now depends on it and deletes `src/github/`; its root no longer re-exports the GitHub types and functions, so import them from `@titan-design/github`.
- 84b230d: Add `CheckRun.appId` and `CheckRun.headSha`, `PullRequest.headRepo`, `jobLogTail`, `deleteRef` (refuses the default branch and fork heads), `listOpenPrs`, `checkRuns` (every run on a sha, superseded ones included), ETag conditional GETs with a shared rate budget that backs off below 500 remaining, and a pure `mergeReadiness`. Ref names containing `%` are now refused. Every `gh api` call now runs with `-i`, and lists follow `Link` pages instead of `--paginate`.
- 19e7b14: Add `listPrFiles` (every page, `previousPath` on a rename, throws `FileListTruncatedError` when GitHub's 3,000-file cap cut the list), `compareFiles` (`mergeBaseSha`, changed paths and `truncated` at GitHub's 300-file and 250-commit caps) and `upsertComment` (lists first, posts once per marker, counts only the authenticated user's comments with the marker alone on a line), each in `fakeGitHub`.
- b0335d0: `execGh` takes an optional third argument `{ timeoutMs }` that SIGKILLs the `gh` child and rejects when the time passes; callers that omit it behave as before. The factory `/health` probe passes 10 s, so a hung `gh` no longer lingers. `service plist` maps a Homebrew Cellar node path to the prefix symlink when it resolves to the same binary, and accepts an absolute `--node <path>`.

### Patch Changes

- e5108b7: TP-566: `execGh` rejects a maxBuffer overflow with its own error instead of the timeout message, and takes an optional `maxBufferBytes`. The egress-scan README now says the hook's `PATH` lookup ignores relative entries.
