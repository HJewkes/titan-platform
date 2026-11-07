---
"@titan-design/factory": patch
---

Add `scratchLockfileRegen`, the `LockfileRegen` port bump-consumers will use. It writes a consumer's manifests to a scratch dir and runs `corepack pnpm@<packageManager> install --lockfile-only --ignore-scripts --ignore-pnpmfile` or `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`. The env is `setupEnv` with every token-shaped key dropped and npm's user config pointed at an empty file. Before running it refuses a pnpmfile or a patch file it was not given. It throws, with redacted output, when the install fails or `lockfileVersion` changed, and it always removes the scratch dir. Nothing calls it yet.
