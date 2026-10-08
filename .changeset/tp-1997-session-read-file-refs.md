---
"@titan-design/session-read": minor
---

session-read now exports `parseFileRef(ref)`, the inverse of `fileRef`: it returns `{ repo, path }` from a `file:` ref, a null repo for an unattributed ref, and null for a ref of another kind. `toRepoRelative` now strips a leaked `.worktrees/<name>/` prefix, so a file touched in a worktree that has since been removed resolves to the same repo-relative path as the live worktree, and returns posix paths. New ingests of such files write `file:<repo>/<path>` instead of `file:<repo>/.worktrees/<name>/<path>`; `parseFileRef` strips the prefix from refs already stored.
