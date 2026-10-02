---
"@titan-design/worktree": patch
---

Worktree setup no longer hangs when a branch's `.npmrc` or `pnpm-workspace.yaml` is a symlink to a device such as `/dev/zero`. The base-identity guard now lstats each guarded file and treats anything that is not a regular file as changed, so setup skips before any read.
