---
"@titan-design/worktree": patch
---

Install the typed-presentation test's git and gh shims through a staged copy so a concurrent fork cannot hold them open for writing (ETXTBSY), which release read as no merged-PR proof and so skipped its post-proof status check.
