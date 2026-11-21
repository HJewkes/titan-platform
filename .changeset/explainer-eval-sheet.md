---
"@titan-design/explainer": patch
---

Add `explainer eval sheet`, which judges a contact-sheet directory with the sheet-critique passes and glow canary, prints the scores, caps, top three fixes and usd spent, and exits 1 on an untrusted run or, with `--min-overall` or `--gate`, a low overall (TP-5886). `critiqueScore` now also returns the `caps` that fired.
