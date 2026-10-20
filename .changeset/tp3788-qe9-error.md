---
"@titan-design/explainer": minor
---

Promote rule Q-E9 (at least 15 s from a dense beat's end to the next dense beat) from warning to error in `doctrine/rules.yaml` and in `paceRows` (TP-3788, owner decision D2). Calibration measured no false positive on the v4 spike script and none on the pilot (pipeline-explainer). The pilot count used planned lengths, because the pilot has no `words.json`. Q-E9's logic is unchanged.
