---
"@titan-design/explainer": minor
---

Add `explainer eval cold`, the cold-viewer probe for Q-E6. It reads a spike or script/v1 file the way `eval pace` does, streams it to a fresh viewer one chapter per call through the configured judge, and runs three times by default. Each run appends `cold-scores.tsv`, `cold-chapters.tsv`, `canaries.tsv` and an `L1-cold` run record keyed by an `eval_version` that includes the judge's identity. Q-E6 is now cited by `rubrics/l1-cold.md`. A cold run's canary result now names the `relay-` item the viewer was asked about, and a label with no word timing is shown at an unknown second rather than from the beat's start (TP-2984).
