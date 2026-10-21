---
"titan-console": patch
---

Ship rounds with several PRs: an earlier round's Addressed tick on one PR's card no longer ticks the same round on another
PR's card. The page and the round draft key each tick by PR; a draft saved before still restores, and `rounds.submit`
still records round numbers only (TP-3885).
