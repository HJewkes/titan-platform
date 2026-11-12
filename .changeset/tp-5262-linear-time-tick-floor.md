---
"@titan-design/tool-guard": patch
---

The linearity check test helper floors its small-side reading at one CPU tick, so a linear run that spans a single tick no longer scores above the limit. Test support only; no guard logic changes.
