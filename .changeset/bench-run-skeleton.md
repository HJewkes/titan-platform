---
"@titan-design/evals": minor
---

Add `titan-evals bench run`, the model-routing bench skeleton. It runs one headless `claude -p` job per (case, arm),
block by block, with at most 6 in flight. Each job gets an `env -i` environment, an allowlisted PATH, its own HOME, a
dead-end proxy, and a per-run deny-list settings file. Rows are fsynced to `jobs.jsonl` (`titan.bench-job/v1`), and a
restart resumes, re-running an `infra` job once. Dispatch pauses under machine pressure and stops at the account's
seven-day cap. Tracks plug in through a small `prepare` / `score` / `cleanup` interface.
