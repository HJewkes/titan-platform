---
"@titan-design/factory": patch
---

Add the pure fact-row comparator for the marker shadow diff (TP-3111 S2a). `compareCall` classifies a live fact-step call against the verdict computed before it as hit, false-hit, miss, miss-same-output or unmarked, recording material and full validity separately. Memo hits and Unavailable answers give no row. Nothing calls it yet.
