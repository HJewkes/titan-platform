---
"@titan-design/explainer": patch
---

`mineHistory` and `validateDecisions` no longer lazily fetch from a partial clone's promisor remote: they pin `protocol.allow=never` and set `GIT_NO_LAZY_FETCH=1`, so a treeless clone fails closed instead of running the transport command its own config names (TP-2871).
