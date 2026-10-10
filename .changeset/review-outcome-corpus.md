---
"@titan-design/evals": minor
---

Add the review outcome corpus: `titan-evals corpus` and `buildCorpus` write one row per reviewed head from the factory database, opened read-only, and git history, with the revert, main-red, later-fix, owner-override and fixer-changed-cited-paths labels and a derived escaped, caught, false-block, clean, pending or unresolved label.
