---
"@titan-design/session-miner": minor
---

`memory.report` now reads the global CLAUDE.md in each Claude root and each project's CLAUDE.md, splits them at second-level headings, and groups the sections with the facts and proposes a destination for them. A CLAUDE.md is never proposed for deletion. The envelope reports `instructionSections`.
