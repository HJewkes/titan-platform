---
"@titan-design/factory": patch
---

`shepherd resync` and serve's startup resync now cancel an approve-merge gate whose PR base moved, or whose base the run may not merge into, as the head-moved sweep does each tick. A run with an owner hold keeps its gate.
