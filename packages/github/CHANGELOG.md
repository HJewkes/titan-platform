# @titan-design/github

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
