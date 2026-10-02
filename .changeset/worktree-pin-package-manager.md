---
"@titan-design/worktree": patch
---

Worktree setup now skips the step when the tree's `.npmrc` differs from origin's default branch, as it already does for `pnpm-workspace.yaml`. A branch that adds, edits or deletes `.npmrc` gets a warning and no setup. It also pins `manage-package-manager-versions=false`, `COREPACK_ENV_FILE=0` and `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=0`. Together these stop a branch's `packageManager` field, `.npmrc` or `.corepack.env` from making setup download and run a package manager of its choosing. A base pinned to an older pnpm now installs with the host's pnpm.
