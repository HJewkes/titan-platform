---
"@titan-design/eslint-plugin": minor
---

Add the opt-in `no-wall-clock-motion` rule. In files under `/ui/beats/` or `/motion/` (option `paths`), it reports `Date.now`, `performance.now`, `Math.random` and the timer calls, and it ignores test and spec files, so beat motion stays a function of the beat's time.
