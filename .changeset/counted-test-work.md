---
"@titan-design/fix-proof": minor
"@titan-design/test-kit": minor
"@titan-design/eslint-plugin": minor
"@titan-design/review-panel": patch
"@titan-design/autoresearch": patch
"@titan-design/code-graph": patch
"@titan-design/tool-guard": patch
---

- **Count work in timing tests instead of reading a clock (TP-4262).** Glob growth tests compared thread CPU ratios, which read up to 415 on a loaded hosted runner and turned main red. fix-proof's `LinearRegExp` now counts its NFA steps (`linearRegExpSteps`), and test-kit's `linearWork` compares those counts across a size ladder. It replaces the timed `linearGrowth`, which is removed. A matcher that falls back to a backtracking RegExp counts nothing and fails at size 1. test-kit also adds `countCalls` and `callMeter`, which count calls to chosen methods and stop at a cap. fix-proof's brace and glob rows and code-graph's reach and link rows use them in place of millisecond limits.
- **Refuse new clock limits in tests.** eslint-plugin adds `no-test-clock-budget`. It reports a test that compares a clock reading, or a ratio of readings, with a limit outside a bench gate. The repo enables it with a shrink-only baseline that TP-4264 empties.
