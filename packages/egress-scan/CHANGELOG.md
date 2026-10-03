# @titan-design/egress-scan

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
