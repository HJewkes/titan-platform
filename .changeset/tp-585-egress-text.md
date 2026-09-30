---
"@titan-design/egress-scan": minor
---

TP-585: the bin passes `--text` to `git show` and `git diff`, so a file git calls binary (one NUL byte is enough) is scanned for its lines instead of skipped; `binary files skipped` is 0 for `pre-push`, `range` and `tree`. A commit whose patch text is over 128 MiB (`MAX_PATCH_BYTES`) exits 2 with one line naming its short sha and the limit, instead of failing on V8's string cap. `--help` gains a line containing `scanned as text`, so a caller can tell this build from 0.1.1. The README states that UTF-16 text is not matched.

A merge commit is now diffed against each parent (`--diff-merges=separate`) instead of with `git show -c`, whose combined diff ignores `--text`: an evil merge that wrote a term into a binary file used to pass with `binary files skipped: 2`. If git still prints a file as binary, the scan exits 2. `parseDiff` folds a path that several parents' diffs name into one file. The commit message is read with `--encoding=UTF-8`, so `i18n.logOutputEncoding` cannot hide a term in it. Minor, not patch: pushes that passed before can now be refused, and `parseDiff` output changes for merge patches.
