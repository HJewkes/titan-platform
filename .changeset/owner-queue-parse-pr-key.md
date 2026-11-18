---
"@titan-design/owner-queue": minor
---

Export `parsePrKey`, the one reader of `pr:` keys, and use it in merge, stale, supersede and recheck. A short sha after `@` no longer counts as a pin in recheck, and stale now trims keys as supersede does.
