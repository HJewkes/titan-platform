---
"@titan-design/factory": patch
---

Add the PR reads for `titan-factory review` (TP-1925 b): `parseTarget` for `owner/repo#N`, `readPrFacts` over the GitHub port, and `ghLineSource`, a lazy, cached file reader over `gh api` capped at 20 files. Not wired to a command yet.
