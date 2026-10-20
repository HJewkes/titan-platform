---
"@titan-design/explainer": minor
---

Port the RF `build_script.py` text lints (L1): the stake band (Q-W1), long sentences (Q-V9), banned phrases, the numbers rule, the outro word cap, owner rules 3 and 5, chip rows and the spoken-list warning, as `rfTextLint` over a spike script read by `readRfScript`. A differential test holds them to the A2 goldens on the frozen v4 and addendum scripts and their seeded variants.
