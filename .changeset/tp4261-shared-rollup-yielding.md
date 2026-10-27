---
"@titan-design/session-graph": minor
"@titan-design/active-work": patch
---

session-graph exports `rollupYielding`, the session-by-session rollup with a yield after each that `refreshCorpus` runs when given a `yieldPoint` (TP-4261). active-work's delta pass and unfinished-turn sweep use it in place of their own copy.
