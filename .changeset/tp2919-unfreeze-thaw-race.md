---
"@titan-design/factory": patch
---

Shepherd's sh-unfreeze re-reads the freeze before it reports the repo still frozen, so a thaw elsewhere during its GitHub reads no longer opens a main-frozen gate after the thaw sweep has already run.
