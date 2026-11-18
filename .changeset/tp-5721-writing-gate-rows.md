---
"@titan-design/explainer": minor
---

Add the writing gate and hallmark rows (TP-5721). `eval l0` gains Q-V16 (`writing:short-register`, an error),
Q-V17 (one `hallmark:*` row per deterministic tell; the naming refrain is an error, the rest warnings) and Q-V18
(`hallmark:named-before-defined`, an error). `eval writing` prints the same rows below the calibrated ones, and an
error row fails its verdict. Thresholds and severities live in `doctrine/writing-gate.json`, which also makes
`phrases` and `variety:connector-share` report-only.
