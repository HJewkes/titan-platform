---
"@titan-design/fix-proof": patch
---

`expandBraces` enforces its 256-alternative cap while expanding, so a glob like `{4096 alternatives}{256 alternatives}` is rejected after 257 strings instead of building the whole product first.
