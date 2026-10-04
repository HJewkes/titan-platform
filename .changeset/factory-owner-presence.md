---
"@titan-design/factory": minor
---

Add `confirmOwner(reason)` and a Swift owner-presence helper built by `pnpm factory:install`. The helper shows the macOS Touch ID or login-password dialog and prints a proof id; cancel, a missing helper, an error and no GUI session all return `undefined`. Nothing calls it yet.
