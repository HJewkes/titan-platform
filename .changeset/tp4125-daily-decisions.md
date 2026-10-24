---
"@titan-design/explainer": minor
---

`explainer run --facts-from gatherDaily` takes `--decisions <file>`, an owner decisions log whose numbered entries stamped inside the UTC day become P1 `decision/<n>` facts (MDT and MST stamps converted, "same time" entries inheriting the stamp before them), and `--lanes <file>`, the lanes rule file. The gather request carries both files' sha256, so editing the host `daily/lanes.yaml` or the log gathers afresh instead of hitting the cache.
