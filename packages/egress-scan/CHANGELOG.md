# @titan-design/egress-scan

## 0.7.0

### Minor Changes

- 45eebed: Add the `@titan-design/egress-scan/hooks` subpath: `writeGitHooks` writes a spawn-time git hooks dir that `gitHooksEnv` points git at. Its pre-push runs `titan-egress-scan pre-push` on a baked PATH, refuses when the private term list is missing, and chains to the repo's own hook. A `noRewriteHooksDir` dir also refuses the deletes, main or master updates, refs outside heads and tags and non-fast-forwards git hands the hook, and pushes to a configured mirror remote; a typed `push --mirror` must be refused before git runs. Relative PATH entries are never baked into the hook. Ported from agent-chat's leak guard; the generated hooks are byte-identical to its own.
- 16bd97d: `/hooks` gains the agent `git` shim: `gitShimScript`, `writeGitShim` and `findRealGit` (which never returns a shim, this one or another, as the real git), the exec-path mirror (`writeGitMirror`, `gitMirrorDirFor`, `mirrorEntries`, `probeGit`), and the shim header check (`SHIM_HEADER`, `isAgentChatShim`, `holdsAgentChatShim`). The shim's transport pin narrows `GIT_ALLOW_PROTOCOL` to `@titan-design/worktree`'s safe list and gives git the same environment as its `withPinnedGitProtocols`. egress-scan now depends on `@titan-design/worktree` and moves to tier 1.
- 87cf6c2: `/hooks` gains `posixShell`, `hardenedShebang`, `ENVIRONMENT_SCRUB` and `hookShell` (the `HookShell` the hooks writer takes), and `ownToolDirs`, `withOwnTools` and `defaultScanInputs`, so a hooks writer whose PATH lacks the scanner still bakes its own scanner and node.
- 6d9f2c7: A private term line may start with a `[category]` tag. A finding on a tagged term carries `category`, and the report prints `[category]` in place of `#<line>`. Untagged lines behave as before; a malformed tag fails the load with a `TermFileError`.

### Patch Changes

- 8a8ab19: A new-branch push no longer trusts local tracking refs. The scan now excludes only commits reachable from the tips the push URL advertises; a forged or stale `refs/remotes/<remote>/*` ref can no longer hide a commit. When the push URL is missing or cannot be listed, a new branch's whole history is scanned.
- 0848c31: `compileGlobs` matches in time linear in the path instead of compiling a backtracking RegExp, so a short glob such as `d/` and twenty `*`, `**/` repeated, or `*a` repeated can no longer hang a fix-proof plan or an egress-scan `.egress-allow` check. Match results are unchanged.
- Updated dependencies [7492819]
- Updated dependencies [9c70c14]
- Updated dependencies [708e154]
- Updated dependencies [6a2471a]
- Updated dependencies [56d107b]
- Updated dependencies [0848c31]
- Updated dependencies [136b507]
- Updated dependencies [f5d92f3]
- Updated dependencies [7a34209]
- Updated dependencies [bea67f1]
- Updated dependencies [ca8e8b7]
- Updated dependencies [8b92ba0]
- Updated dependencies [36dc03f]
- Updated dependencies [f3d3107]
- Updated dependencies [661a027]
- Updated dependencies [4080191]
- Updated dependencies [32637bd]
- Updated dependencies [2451aa9]
- Updated dependencies [d2cce6c]
- Updated dependencies [719f05e]
- Updated dependencies [8031169]
- Updated dependencies [247171d]
- Updated dependencies [9ad447f]
- Updated dependencies [d5e44a5]
  - @titan-design/fix-proof@0.9.0
  - @titan-design/worktree@0.4.0

## 0.6.7

### Patch Changes

- Updated dependencies [749bea7]
  - @titan-design/fix-proof@0.8.0

## 0.6.6

### Patch Changes

- Updated dependencies [4d131dc]
  - @titan-design/fix-proof@0.7.0

## 0.6.5

### Patch Changes

- Updated dependencies [6aa69f2]
  - @titan-design/fix-proof@0.6.0

## 0.6.4

### Patch Changes

- Updated dependencies [59131da]
- Updated dependencies [62adbb2]
- Updated dependencies [336aaf2]
- Updated dependencies [7499737]
- Updated dependencies [069c3b2]
- Updated dependencies [15b5395]
- Updated dependencies [462e693]
- Updated dependencies [7d93a92]
- Updated dependencies [edcb589]
- Updated dependencies [b6072b5]
  - @titan-design/fix-proof@0.5.0

## 0.6.3

### Patch Changes

- Updated dependencies [8bc0f25]
- Updated dependencies [ef240c0]
  - @titan-design/fix-proof@0.4.0

## 0.6.2

### Patch Changes

- e9a7eb9: Stop `pre-push` from flagging a merge commit for content that came in from a parent the remote already has. With the push URL listed, a two-parent merge is diffed against a re-merge of its parents, so a conflict resolution or evil merge is still scanned. When the remote cannot be listed, every parent is diffed as before.

## 0.6.1

### Patch Changes

- 9babb5d: Pre-push no longer re-scans commits the remote already has when a branch merged main: the range for a known remote sha now also excludes every commit reachable from the remote's refs.

## 0.6.0

### Minor Changes

- f5c199d: Add the `credential-token` rule. It flags GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), Anthropic (`sk-ant-`), AWS access key id (`AKIA`/`ASIA`), Slack (`xox[abprs]-`) and PEM private-key shapes, each checked for length and charset. A finding names the token's kind (`<location> credential-token github`) and never the token. The rule is never allowable, and the report summary gains a `credential-token` count.

## 0.5.1

### Patch Changes

- Updated dependencies [63c2836]
  - @titan-design/fix-proof@0.3.0

## 0.5.0

### Minor Changes

- f7161c0: `.egress-allow` globs now compile through fix-proof's shared glob compiler, so `docs/{a,b}.md` expands braces instead of matching nothing. The literal-segment guard checks every brace alternative. `AllowEntry.pattern` (a `RegExp`) is replaced by `AllowEntry.matches`. fix-proof exports `expandBraces`.

### Patch Changes

- f7161c0: `expandBraces` rejects a glob longer than 1024 characters or with more than 32 brace groups before expanding, so single-choice brace chains cannot exhaust memory. egress-scan turns any glob compile failure into an `AllowFileError`, and the root `prepare` builds fix-proof before egress-scan.
- Updated dependencies [f7161c0]
- Updated dependencies [f7161c0]
- Updated dependencies [f7161c0]
  - @titan-design/fix-proof@0.2.0

## 0.4.0

### Minor Changes

- 744aa37: Add `titan-egress-scan text [--file <path>]`, which scans free text from stdin or a file (a PR title, body or branch name) with the generic rules and private terms. Findings are `line:col` plus the rule id, never the matched text; exit codes match `range` and `pre-push`. A repeated `--file` exits 2. Option parse errors no longer echo the offending argument, for every command. The library gains `scanText` and `locateRules`, and `CliIo` gains `readFile`.

## 0.3.0

### Minor Changes

- 96c4336: Scan each commit's author and committer name and email, and the ref names a pre-push sends. A finding names the field (`author.name`, `committer.email`, `push line 1 local ref`). Minor, not patch: pushes that passed before can now be refused, and `ScanSource` gains an `idents` field and `IdentField` export. Docs now state that UTF-16 text is not scanned.

## 0.2.0

### Minor Changes

- d158040: TP-585: the bin passes `--text` to `git show` and `git diff`, so a file git calls binary (one NUL byte is enough) is scanned for its lines instead of skipped; `binary files skipped` is 0 for `pre-push`, `range` and `tree`. A commit whose patch text is over 128 MiB (`MAX_PATCH_BYTES`) exits 2 with one line naming its short sha and the limit, instead of failing on V8's string cap. `--help` gains a line containing `scanned as text`, so a caller can tell this build from 0.1.1. The README states that UTF-16 text is not matched.

  A merge commit is now diffed against each parent (`--diff-merges=separate`) instead of with `git show -c`, whose combined diff ignores `--text`: an evil merge that wrote a term into a binary file used to pass with `binary files skipped: 2`. If git still prints a file as binary, the scan exits 2. `parseDiff` folds a path that several parents' diffs name into one file. The commit message is read with `--encoding=UTF-8`, so `i18n.logOutputEncoding` cannot hide a term in it. Minor, not patch: pushes that passed before can now be refused, and `parseDiff` output changes for merge patches.

### Patch Changes

- 2287881: `tree` now refuses a tree whose patch text is over `MAX_PATCH_BYTES` (128 MiB): it exits 2 with one line naming `tree` and the limit, as `range` and `pre-push` do for a commit. `readTree` takes an optional limit and throws `PatchTooLargeError`, whose first argument is now `undefined` for a tree.

## 0.1.1

### Patch Changes

- 15fa012: The pre-push hook now finds the scanner in the pushing worktree, then the main checkout's `node_modules`, then `PATH`, so a linked worktree without `node_modules` can push. It still exits 1 when none is found, and the message names the three places it looked.

  The `PATH` step skips relative and empty entries, so a scanner planted in the pushed tree can never be the one that runs.

- 6c1555b: `TITAN_EGRESS_REQUIRE_TERMS=1` now fails closed: `CI` in the environment no longer skips term loading, and a term list with zero terms exits 2 instead of passing.
- e5108b7: TP-566: `execGh` rejects a maxBuffer overflow with its own error instead of the timeout message, and takes an optional `maxBufferBytes`. The egress-scan README now says the hook's `PATH` lookup ignores relative entries.

## 0.1.0

### Minor Changes

- 3f404c3: Add the `titan-egress-scan` bin: `pre-push`, `range`, `tree` and `install-hook` commands, per-commit scanning with `git show -c` so merge commits are covered, the private term list lookup (skipped in CI, a notice when absent, exit 2 under `TITAN_EGRESS_REQUIRE_TERMS=1`), and a shipped POSIX pre-push hook that fails closed when the scanner is not installed.
- 8e1e439: Add the egress-scan core: the `home-path`, `aw-data-path` and `private-term` rules, a `-U0` patch and commit parser, `scan`, the `.egress-allow` parser (a task id per entry, a literal path segment per glob, no private-term entries), the private term list parser (rejecting terms that match the empty string), and a report that carries locations and rule ids but never the matched text.
