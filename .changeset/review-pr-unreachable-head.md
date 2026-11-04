---
"@titan-design/evals": patch
---

`titan-evals review-pr cases` skips a corpus row whose head, or next head, the local clone no longer holds, and counts it as `head-unreachable` in the manifest's `skipped`. Before, one such row aborted the whole build (TP-4114).
