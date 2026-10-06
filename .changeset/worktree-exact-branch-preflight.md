---
"@titan-design/worktree": patch
---

Match branch names exactly when finding the worktree that holds a branch, so allocating `scout` no longer fails while `scout-2` holds its tree. `check` and `allocate` now share one preflight: `check` reports no budget refusal for an assigned worktree, and reports a refusal when the branch is checked out elsewhere, its directory is in the way, or an assigned worktree is gone with no record to re-create it.
