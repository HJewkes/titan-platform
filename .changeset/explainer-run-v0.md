---
"@titan-design/explainer": minor
---

Add `explainer run`: one video end to end as an `explainer-video` run on `@titan-design/workflow`, with `state.sqlite3` and a content-addressed artifact store in the data dir. The stages run in order as code steps: `script` (one model call from the spine and facts, parsed with `ScriptSchema`, one schema retry), `rewrite`, `eval` (L0 with the spine lints, and pace), then `tts`, `render`, `qa` and `sheets` through a bridge host file kept outside the repo, then `export` to the theater folder. Each stage record holds its own timing, usage, retries, checks and output shas. `--from <stage>` reuses a base run's records at no cost, `--budget-usd` is a resumable hard stop naming the stage, `explainer run resume` picks a run up, and `explainer run report` writes `run-report.md` with per-stage wall time, usd, tokens, retries, cache hits, output shas and the bridged stages marked.
