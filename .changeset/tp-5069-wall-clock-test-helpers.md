---
"@titan-design/eslint-plugin": patch
---

`titan/no-wall-clock-motion` now exempts `*.test-helpers.ts` files itself, so every consumer of the rule skips its test helpers.
