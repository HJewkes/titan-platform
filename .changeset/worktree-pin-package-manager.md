---
"@titan-design/worktree": patch
---

Worktree setup pins `manage-package-manager-versions=false`, `COREPACK_ENV_FILE=0` and `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=0`, so a branch's `packageManager` field, `.npmrc` registry or `.corepack.env` can no longer make the setup step download and run a package manager of its choosing.
