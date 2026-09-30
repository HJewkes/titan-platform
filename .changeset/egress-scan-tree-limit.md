---
"@titan-design/egress-scan": patch
---

`tree` now refuses a tree whose patch text is over `MAX_PATCH_BYTES` (128 MiB): it exits 2 with one line naming `tree` and the limit, as `range` and `pre-push` do for a commit. `readTree` takes an optional limit and throws `PatchTooLargeError`, whose first argument is now `undefined` for a tree.
