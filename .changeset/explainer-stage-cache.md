---
"@titan-design/explainer": minor
---

Run each `explainer run` stage but `export` as its own `explainer.<stage>` child workflow behind a stage cache. The stage key hashes the stage, its definition version, its settings and variant, the input shas it reads and the sample index, never its outputs; the `explainer_stage_runs` table maps a key to its child run, and a key whose child is live or orphaned is adopted instead of started twice. Adds `explainer stage <name> --in name=sha [--variant <file>] [--sample k]`, `run --to`, `--pin name=sha`, `--variant stage=file` (`explainer.variant/v1`), `--sample stage=k` and `--video`, `{var.<name>}` tokens in `bridge.json`, and `run report --compare <runId>`. A run ends at the theater; a follow-up run from stored artifacts joins its base run's video, and every run's report lists the video's other runs and sums their spend.
