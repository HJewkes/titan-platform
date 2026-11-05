---
"@titan-design/factory": patch
---

A red main's fixer now picks its account the way fix-round successors do (TP-3962). Before, it always spawned under `shepherd.fixer.configDir`. Now it takes the first account with headroom from `shepherd.fixer.configDir` (or `shepherd.review.configDir`), then `shepherd.review.fallbackConfigDirs`. A woken fixer or successor whose session ends on Claude Code's usage-limit notice now marks its account exhausted in the account-limit store, as a reviewer's does, so the next successor spawns on another account.
