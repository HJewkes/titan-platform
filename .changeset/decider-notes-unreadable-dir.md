---
"@titan-design/decider": patch
---

The decision-notes source reports a notes directory it cannot read in `SourceRead.errors` instead of silently dropping its precedents; only a missing directory stays silent.
