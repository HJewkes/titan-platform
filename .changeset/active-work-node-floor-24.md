---
'@titan-design/active-work': patch
---

`active-work setup` and `active-work doctor` now require Node 24, the engines minimum, through one shared constant and version parser. They no longer pass Node 22 and 23.
