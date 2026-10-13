---
"@titan-design/session-miner": patch
---

Add `titan-miner throughput review`, which loads the PR diff cache, and optionally Shepherd's per-run stats via `--shepherd-runs`, into `taskActuals`. It prints the review table keyed on review class x lead touch and the per-target ablation of the diff arm against the kind x size-band arm, with the model hash and cache coverage, in text and `--json` (TP-2162 d).
