---
"@titan-design/authority": patch
---

`evaluate()` now denies a request whose actor is missing, null, not an object, or carries no known actor class, instead of throwing.
