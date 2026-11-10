---
"@titan-design/active-work": patch
---

Split `assembleBootstrap` into a defaults step, an I/O gather phase and an ordered list of section builders, so no bootstrap function exceeds cyclomatic 15. The prompt and metadata are byte-identical; a golden test now pins both.
