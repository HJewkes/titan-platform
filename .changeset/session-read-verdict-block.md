---
"@titan-design/session-read": minor
---

Add `parseVerdictBlock(text)`, a fail-closed reader for the three-line `Verdict: MERGE|FIX_FIRST`, `PR: owner/name#n`, `Head: <40 lowercase hex>` block a reviewer sends. It finds the block on any line, refuses zero or two blocks, quoted or fenced blocks, `APPROVE`, `CHANGES`, and any short, upper-case or over-long head, and returns `lineOffset` on success.
