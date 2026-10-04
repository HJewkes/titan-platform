---
"@titan-design/factory": patch
---

Shepherd cleanup re-reads the agent roster fresh just before retiring, so an agent resumed inside the roster cache window is no longer retired.
