---
"@titan-design/factory": patch
---

Shepherd's fix-proof read no longer distrusts several fix-proof runs at one head when every one of them reads NO_REPRO, as a PR reopened at the same head has. It reads the newest, so a vacuous correctness fix goes to the fix-proof wake instead of on to review. Any set of runs that includes a proof stays untrusted as before.
