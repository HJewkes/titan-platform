# @titan-design/github

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
