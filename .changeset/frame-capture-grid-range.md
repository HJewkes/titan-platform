---
"@titan-design/frame-capture": patch
---

`checkPops` now throws a RangeError naming `start` and `end` when `start` is after `end`, instead of seeking `undefined`.
