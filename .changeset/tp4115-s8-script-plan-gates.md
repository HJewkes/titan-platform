---
"@titan-design/explainer": patch
---

The script stage now gates the draft on `word-budget`, the same per-beat and per-block caps resolve enforces (both call `scriptBudgets`), and on `runtime`, the summed plannedS against the profile's [minS, maxS] or one of its cuts' bands. The script prompt names each lead beat's words-per-second cap and the profile's target runtime. A parsed draft that fails either makes one retry whose hint names each beat as words/cap with the seconds its words need, and the planned total against the profile; the retry is kept only when it fails fewer.
