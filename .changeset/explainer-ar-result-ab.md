---
"@titan-design/explainer": patch
---

Add `explainer ab --ar-result`, which runs the script stage per stored case and repeat and prints one `ar-result/v2` line each, stopping before a run that would pass `--max-usd`, and rename the L0 violation count `l0_error_rows` (TP-6305).
