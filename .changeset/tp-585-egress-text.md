---
"@titan-design/egress-scan": patch
---

TP-585: the bin passes `--text` to `git show` and `git diff`, so a file git calls binary (one NUL byte is enough) is scanned for its lines instead of skipped; `binary files skipped` is 0 for `pre-push`, `range` and `tree`. A commit whose patch text is over 128 MiB (`MAX_PATCH_BYTES`) exits 2 with one line naming its short sha and the limit, instead of failing on V8's string cap. `--help` gains a line containing `scanned as text`, so a caller can tell this build from 0.1.1. The README states that UTF-16 text is not matched.
