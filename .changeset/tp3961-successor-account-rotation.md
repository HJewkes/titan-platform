---
"@titan-design/factory": patch
---

Shepherd's fix-round successors now follow the review account rotation (TP-3961). A successor spawns under the first account with headroom in the account-limit store: `shepherd.fixer.configDir` (or `shepherd.review.configDir` when unset), then `shepherd.review.fallbackConfigDirs`. Before, it always took agent-chat's default account, even while that account was out of usage. When every account is exhausted, or the store cannot be read, a successor still spawns under the first account.
