---
"@titan-design/github": minor
"@titan-design/factory": patch
---

`land-rules` no longer fails every run on a private free-plan repo (TP-1899). When the rules read answers HTTP 403 "Upgrade to GitHub Pro" and the branch endpoint reports `protected: false`, the base reads as requiring no checks, so `ci-wait` requires every check-run at the head to be green. Any other 403, a `protected: true` or an unreadable branch still refuses. `@titan-design/github` gains `branchProtected` on the port and `getBranchProtected` on the wire.
