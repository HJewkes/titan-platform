---
"@titan-design/factory": patch
---

`behindMain` counts every main commit behind a `-dirty` build instead of clearing the ones outside the factory closure, since a dirty build may hold uncommitted closure edits.
