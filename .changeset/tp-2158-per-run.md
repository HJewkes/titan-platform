---
"@titan-design/factory": minor
---

`titan-factory shepherd stats --per-run --json` prints `{ perRun: [...] }`, one record per shepherd-pr run started in range: task, repo, pr, kind (from the registration, else `unknown`), status, start and completion, minutes per stage summed from the stage spans, review rounds as distinct verdict heads, and the merge time with its path (`shepherd`, `outside` or null). `--per-run` without `--json` exits 2.
