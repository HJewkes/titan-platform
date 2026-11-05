---
"@titan-design/explainer": minor
---

Judge calibration round two (TP-4012, Q3): under `--max-density`, `explainer eval calibrate queue` adds 3 "Is this chapter clear enough to follow on one hearing?" items on top of `--size`, for the chapters nearest the bar on either side of it, with each chapter's listener density in the key. The new `explainer eval calibrate listener-labels` turns a submitted round into `listener-labels/v1` rows (a yes or no per chapter beside its density) for TP-4080's threshold.
