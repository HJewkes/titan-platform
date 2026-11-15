---
"@titan-design/active-work": patch
---

`aw open` with no slug returns an empty picker and one warning when the active root cannot be read (EACCES, ENOTDIR), instead of throwing. A missing root still returns an empty picker with no warning (TP-6222).
