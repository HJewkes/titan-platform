---
"@titan-design/explainer": minor
---

Judge calibration round two (TP-4012): `explainer eval calibrate queue` asks audition pick-versus-runner-up pairs as blind A/B questions scored for the `audition-code` and `audition-rubric` pickers, screens items by listener density with `--max-density` (clearest video first), keys each entry with its judge's eval_version, and takes `--round`. `explainer eval calibrate agreement` pools repeated `--key`/`--feedback` rounds, counting an earlier round's item at another eval_version as stale.
