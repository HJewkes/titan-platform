---
"@titan-design/factory": patch
---

Registration refusals in `shepherd register` (policy, owner-gate reasons, refused kind moves) now throw `EXIT.REFUSED` instead of `EXIT.DATAERR`. The status is still 65; bad-input errors keep `EXIT.DATAERR`.
