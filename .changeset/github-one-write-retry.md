---
"@titan-design/github": patch
---

Build upsertComment and updateBranch on writeWithReadBack: one retry loop, with each write's delay schedule kept as a named constant and its read-back as a `landed()` probe. No retry timing or outcome changes.
