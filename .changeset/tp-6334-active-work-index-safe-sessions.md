---
"@titan-design/active-work": patch
---

Make the sessions, session-index, drain, discover, utils, setup and wrap modules and their tests compile under `noUncheckedIndexedAccess`. Behaviour is unchanged; an indexed read that cannot be satisfied now falls back to an empty value or skips the row instead of reading `undefined`.
